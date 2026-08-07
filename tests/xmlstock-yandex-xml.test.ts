import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ENV_FILE и снапшот process.env вычисляются при импорте shared/config.js —
// поэтому env выставляется ДО динамического импорта модуля (образец — tests/xmlstock-serp.test.ts).
// Временный env-файл делает тест герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let collectSerp: typeof import('../servers/xmlstock/src/serp.js').collectSerp;
let extractFound: typeof import('../servers/xmlstock/src/serp.js').extractFound;
let extractFoundDocs: typeof import('../servers/xmlstock/src/serp.js').extractFoundDocs;
let extractFoundHuman: typeof import('../servers/xmlstock/src/serp.js').extractFoundHuman;
let isEmptySerp: typeof import('../servers/xmlstock/src/serp.js').isEmptySerp;
let xmlstockGet: typeof import('../servers/xmlstock/src/serp.js').xmlstockGet;
let yandexXmlCommon: typeof import('../servers/xmlstock/src/serp.js').yandexXmlCommon;
let yandexXmlCost: typeof import('../servers/xmlstock/src/serp.js').yandexXmlCost;
let parseDocs: typeof import('../shared/src/serp/parse.js').parseDocs;
let parseXml: typeof import('../shared/src/serp/xml.js').parseXml;
let dir: string;

const YANDEX_XML = 'https://xmlstock.com/yandex/xml/';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-xmlstock-yxml-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  // цена yandex_xml задана явно — проверяем, что отдельный тариф подхватывается из конфига
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'XMLSTOCK_USER=u\nXMLSTOCK_KEY=k\nXMLSTOCK_YANDEX_XML_PRICE_PER_CALL=0.1\n', {
    mode: 0o600,
  });
  ({ collectSerp, extractFound, extractFoundDocs, extractFoundHuman, isEmptySerp, xmlstockGet, yandexXmlCommon, yandexXmlCost } =
    await import('../servers/xmlstock/src/serp.js'));
  ({ parseDocs } = await import('../shared/src/serp/parse.js'));
  ({ parseXml } = await import('../shared/src/serp/xml.js'));
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

function fakeRes(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

/** XML-ошибка XMLStock (HTTP 200 + <error code> в теле). */
const errXml = (code: number, text: string) =>
  `<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><response><error code="${code}">${text}</error></response></yandexsearch>`;

const docXml = (n: number, offset = 0) =>
  Array.from(
    { length: n },
    (_, i) => `<doc id="D${offset + i}"><url>https://site${offset + i}.ru/</url><title>t${offset + i}</title></doc>`,
  ).join('');

const serpXml = (docs: string, head = '') =>
  `<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><response>${head}<results><grouping groups-on-page="100"><group>${docs}</group></grouping></results></response></yandexsearch>`;

// Реальный фрагмент официального Яндекс.XML: found ≠ found-docs, hlword в title и passages,
// служебные поля документа (id/domain/modtime/saved-copy-url/is-local), страницы с 0.
const OFFICIAL_XML = `<?xml version="1.0" encoding="utf-8"?>
<yandexsearch version="1.0">
  <response>
    <found priority="phrase">5</found>
    <found priority="strict">48</found>
    <found priority="all">171000</found>
    <found-docs priority="strict">48</found-docs>
    <found-docs priority="all">170000</found-docs>
    <found-docs-human>170 тысяч результатов</found-docs-human>
    <page first="1" last="102">0</page>
    <results>
      <grouping attr="d" mode="deep" groups-on-page="100" docs-in-group="1" curcateg="-1">
        <group>
          <doc id="Z0A1B2">
            <url>https://example.ru/flats</url>
            <domain>example.ru</domain>
            <title><hlword>Купить</hlword> <hlword>квартиру</hlword> в Москве — example.ru</title>
            <modtime>20260701T120000</modtime>
            <saved-copy-url>http://hghltd.yandex.net/yandbtm?url=example.ru</saved-copy-url>
            <is-local>1</is-local>
            <passages><passage>Большой выбор: <hlword>купить квартиру</hlword> без посредников.</passage></passages>
          </doc>
        </group>
      </grouping>
    </results>
  </response>
</yandexsearch>`;

let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // глушим stderr-логи (cost/retry), но оставляем spy для проверок списаний
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Было ли списание (CostLogger пишет «вызовов за сессию» в stderr). */
const costTracked = () => errSpy.mock.calls.some((c) => String(c[0]).includes('вызовов за сессию'));

describe('parseDocs: официальный Яндекс.XML', () => {
  it('ест doc с id-атрибутом, hlword-подсветками и служебными полями', () => {
    const { docs } = parseDocs(parseXml(OFFICIAL_XML));
    expect(docs).toHaveLength(1);
    const d = docs[0];
    expect(d.url).toBe('https://example.ru/flats');
    expect(d.domain).toBe('example.ru');
    expect(d.id).toBe('Z0A1B2');
    expect(d.modtime).toBe('20260701T120000');
    expect(d.saved_copy_url).toBe('http://hghltd.yandex.net/yandbtm?url=example.ru');
    expect(d.is_local).toBe(true);
    expect(d.title).toBe('Купить квартиру в Москве — example.ru');
    expect(d.snippet).toBe('Большой выбор: купить квартиру без посредников.');
    // подсветки: соседние hlword в title склеиваются в одну фразу + hlword из passage
    expect(d.text_bolds).toContain('Купить квартиру');
    expect(d.text_bolds).toContain('купить квартиру');
  });
});

describe('found vs found-docs', () => {
  it('extractFound / extractFoundDocs / extractFoundHuman не перепутаны', () => {
    const doc = parseXml(OFFICIAL_XML);
    expect(extractFound(doc)).toBe(171000); // found priority="all"
    expect(extractFoundDocs(doc)).toBe(170000); // found-docs priority="all" — НЕ перетирает found
    expect(extractFoundHuman(doc)).toBe('170 тысяч результатов');
  });

  it('без found-docs → foundDocs/foundHuman = null, found читается как раньше', () => {
    const doc = parseXml(serpXml(docXml(1), '<found priority="all">7</found>'));
    expect(extractFound(doc)).toBe(7);
    expect(extractFoundDocs(doc)).toBeNull();
    expect(extractFoundHuman(doc)).toBeNull();
  });
});

describe('yandexXmlCommon', () => {
  it('safeSearch маппится в семейный фильтр filter (strict/moderate/none)', () => {
    const base = { query: 'q', region: 'Москва', sortby: 'relevance' as const };
    expect(yandexXmlCommon({ ...base, safeSearch: 'strict' }).filter).toBe('strict');
    expect(yandexXmlCommon({ ...base, safeSearch: 'moderate' }).filter).toBe('moderate');
    expect(yandexXmlCommon({ ...base, safeSearch: 'off' }).filter).toBe('none');
  });

  it('lr обязателен, sortby=date → tm, maxpassages пробрасывается', () => {
    const p = yandexXmlCommon({ query: 'q', region: 'Москва', sortby: 'date', safeSearch: 'moderate', maxpassages: 3 });
    expect(p.lr).toBe(213);
    expect(p.sortby).toBe('tm');
    expect(p.maxpassages).toBe(3);
    // дефолтная сортировка (rlv) не шлётся
    expect(yandexXmlCommon({ query: 'q', region: '225', sortby: 'relevance', safeSearch: 'moderate' }).sortby).toBeUndefined();
  });
});

describe('collectSerp: groupby официального Яндекс XML', () => {
  const lastUrl = (fetch: ReturnType<typeof vi.fn>, i: number) => String(fetch.mock.calls[i][0]);

  it('depth≤100 → ОДИН запрос с groupby=depth', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(serpXml(docXml(50), '<found priority="all">500</found>')));
    vi.stubGlobal('fetch', fetch);
    const r = await collectSerp(YANDEX_XML, { query: 'x', lr: 213, filter: 'moderate' }, 50, undefined, {
      groupby: 50,
      cost: yandexXmlCost,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastUrl(fetch, 0)).toContain('groupby=50');
    expect(lastUrl(fetch, 0)).toContain('page=0');
    expect(lastUrl(fetch, 0)).toContain(YANDEX_XML);
    expect(r.results).toHaveLength(50);
    expect(r.truncated).toBe(false);
    expect(r.found).toBe(500);
  });

  it('depth=150 → groupby=100, добор второй страницей (page=1)', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(100))))
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(50, 100))));
    vi.stubGlobal('fetch', fetch);
    const r = await collectSerp(YANDEX_XML, { query: 'x', lr: 213 }, 150, undefined, { groupby: 100, cost: yandexXmlCost });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(lastUrl(fetch, 0)).toContain('groupby=100');
    expect(lastUrl(fetch, 0)).toContain('page=0');
    expect(lastUrl(fetch, 1)).toContain('groupby=100');
    expect(lastUrl(fetch, 1)).toContain('page=1');
    expect(r.results).toHaveLength(150);
    expect(r.results[149].position).toBe(150); // нумерация сквозная
    expect(r.truncated).toBe(false);
  });

  it('неполная первая страница (docs<groupby) → СТОП без лишнего платного запроса', async () => {
    // depth=100, но реально 55 результатов: страница 0 отдаёт 55 (<100) → добора быть НЕ должно
    const fetch = vi.fn().mockResolvedValue(fakeRes(serpXml(docXml(55), '<found priority="all">55</found>')));
    vi.stubGlobal('fetch', fetch);
    const r = await collectSerp(YANDEX_XML, { query: 'x', lr: 213 }, 100, undefined, { groupby: 100, cost: yandexXmlCost });
    expect(fetch).toHaveBeenCalledTimes(1); // ключевое: НЕ ушёл второй платный запрос page=1
    expect(r.results).toHaveLength(55);
    expect(r.truncated).toBe(true); // 55 < depth 100
  });

  it('код 15 → empty=true, запрос тарифицирован', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(errXml(15, 'ничего не найдено'))));
    const r = await collectSerp(YANDEX_XML, { query: 'x', lr: 213 }, 10, undefined, { groupby: 10, cost: yandexXmlCost });
    expect(isEmptySerp(await xmlstockGet(YANDEX_XML, { query: 'x', lr: 213 }, undefined, yandexXmlCost))).toBe(true);
    expect(r.empty).toBe(true);
    expect(r.results).toEqual([]);
    expect(costTracked()).toBe(true);
  });
});

describe('тариф yandex_xml', () => {
  it('успешный запрос списывается по ОТДЕЛЬНОМУ тарифу (env XMLSTOCK_YANDEX_XML_PRICE_PER_CALL)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(serpXml(docXml(1)))));
    await xmlstockGet(YANDEX_XML, { query: 'x', lr: 213 }, undefined, yandexXmlCost);
    const line = errSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('[xmlstock-yandex-xml]') && s.includes('вызовов за сессию'));
    expect(line).toBeDefined();
    expect(line).toContain('yandex_xml');
    // CostLogger — синглтон модуля и копит счётчик между тестами файла (errSpy при этом
    // свежий в каждом тесте): сверяем пары «вызовов → расход», расход = вызовы × цена из env (0.1)
    const m = /вызовов за сессию: (\d+), ~расход: ([\d.]+) ₽/.exec(line!);
    expect(m).toBeTruthy();
    expect(Number(m![2])).toBeCloseTo(Number(m![1]) * 0.1, 2); // цена 0.1 из env-файла, не дефолт 0.024
  });

  it('невалидный/HTML-ответ → ошибка БЕЗ списания', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('<html><body>Authorization failed</body></html>')));
    await expect(xmlstockGet(YANDEX_XML, { query: 'x' }, undefined, yandexXmlCost)).rejects.toThrow(/не-XML\/невалидный ответ/);
    expect(costTracked()).toBe(false);
  });
});
