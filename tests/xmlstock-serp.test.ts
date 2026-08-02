import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ENV_FILE и снапшот process.env вычисляются при импорте shared/config.js —
// поэтому env выставляется ДО динамического импорта модуля (образец — tests/shared-config.test.ts).
// Временный env-файл делает тест герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let collectSerp: typeof import('../servers/xmlstock/src/serp.js').collectSerp;
let extractFound: typeof import('../servers/xmlstock/src/serp.js').extractFound;
let isEmptySerp: typeof import('../servers/xmlstock/src/serp.js').isEmptySerp;
let resolveLr: typeof import('../servers/xmlstock/src/serp.js').resolveLr;
let xmlstockGet: typeof import('../servers/xmlstock/src/serp.js').xmlstockGet;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-xmlstock-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'XMLSTOCK_USER=u\nXMLSTOCK_KEY=k\n', { mode: 0o600 });
  ({ collectSerp, extractFound, isEmptySerp, resolveLr, xmlstockGet } = await import('../servers/xmlstock/src/serp.js'));
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

const GOOGLE = 'https://xmlstock.com/google/xml/';

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
  Array.from({ length: n }, (_, i) => `<doc><url>https://site${offset + i}.ru/</url><title>t${offset + i}</title></doc>`).join('');

const serpXml = (docs: string, found = '') =>
  `<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><response>${found}<results><grouping><group>${docs}</group></grouping></results></response></yandexsearch>`;

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

describe('extractFound', () => {
  const docWithFound = (found: any) => ({ yandexsearch: { response: { found } } });

  it('выбирает found с priority="all" из нескольких', () => {
    const doc = docWithFound([
      { '@_priority': 'strict', '#text': '5' },
      { '@_priority': 'all', '#text': '1234' },
    ]);
    expect(extractFound(doc)).toBe(1234);
  });

  it('priority="all" находится независимо от позиции в массиве', () => {
    const doc = docWithFound([
      { '@_priority': 'all', '#text': '1234' },
      { '@_priority': 'strict', '#text': '5' },
    ]);
    expect(extractFound(doc)).toBe(1234);
  });

  it('фолбэк — первый found, если priority="all" нет', () => {
    const doc = docWithFound([
      { '@_priority': 'strict', '#text': '5' },
      { '@_priority': 'other', '#text': '9' },
    ]);
    expect(extractFound(doc)).toBe(5);
  });

  it('легитимный 0 НЕ превращается в null', () => {
    expect(extractFound(docWithFound({ '@_priority': 'all', '#text': '0' }))).toBe(0);
    expect(extractFound(docWithFound('0'))).toBe(0);
  });

  it('found отсутствует/пустой → null', () => {
    expect(extractFound({ yandexsearch: { response: {} } })).toBeNull();
    expect(extractFound({})).toBeNull();
    expect(extractFound(docWithFound({ '@_priority': 'all', '#text': '' }))).toBeNull();
  });

  it('нечисловое значение → null', () => {
    expect(extractFound(docWithFound('abc'))).toBeNull();
  });
});

describe('xmlstockGet', () => {
  it('невалидный/HTML-ответ → понятная ошибка БЕЗ списания', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('<html><body>Authorization failed</body></html>')));
    await expect(xmlstockGet(GOOGLE, { query: 'x' })).rejects.toThrow(/не-XML\/невалидный ответ/);
    expect(costTracked()).toBe(false);
  });

  it('голый текст (не XML вообще) → та же ошибка без списания', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('Internal Server Error')));
    await expect(xmlstockGet(GOOGLE, { query: 'x' })).rejects.toThrow(/не-XML\/невалидный ответ/);
    expect(costTracked()).toBe(false);
  });

  it('код 15 — валидная пустая выдача: doc возвращается, списание засчитано', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(errXml(15, 'По вашему запросу ничего не найдено'))));
    const doc = await xmlstockGet(GOOGLE, { query: 'x' });
    expect(isEmptySerp(doc)).toBe(true);
    expect(costTracked()).toBe(true);
  });

  it('код 31 — ошибка с подсказкой про ключи', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(errXml(31, 'Неверный ключ'))));
    await expect(xmlstockGet(GOOGLE, { query: 'x' })).rejects.toThrow(/XMLSTOCK_USER\/XMLSTOCK_KEY/);
    expect(costTracked()).toBe(false);
  });

  it('исчерпание ретраев → ошибка с кодом и текстом последней попытки', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockResolvedValue(fakeRes(errXml(500, 'Выполните перезапрос')));
      vi.stubGlobal('fetch', fetch);
      const p = xmlstockGet(GOOGLE, { query: 'x' });
      const assertion = expect(p).rejects.toThrow('XMLStock error 500: Выполните перезапрос — исчерпаны ретраи (4 попытки)');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(costTracked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ретрай после временной ошибки приводит к успеху', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(fakeRes(errXml(500, 'Выполните перезапрос')))
        .mockResolvedValueOnce(fakeRes(serpXml(docXml(3), '<found priority="all">3</found>')));
      vi.stubGlobal('fetch', fetch);
      const p = xmlstockGet(GOOGLE, { query: 'x' });
      await vi.advanceTimersByTimeAsync(5_000);
      const doc = await p;
      expect(doc?.yandexsearch?.response?.results).toBeTruthy();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(costTracked()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('collectSerp', () => {
  it('truncated=true, когда выдача кончилась раньше depth; нумерация сквозная', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(10), '<found priority="all">15</found>')))
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(5, 10))))
      .mockResolvedValueOnce(fakeRes(serpXml('')));
    vi.stubGlobal('fetch', fetch);
    const r = await collectSerp(GOOGLE, { query: 'x' }, 25);
    expect(r.results).toHaveLength(15);
    expect(r.truncated).toBe(true);
    expect(r.found).toBe(15);
    expect(r.results[14].position).toBe(15);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('depth набран → truncated=false', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(serpXml(docXml(10), '<found priority="all">100</found>')));
    vi.stubGlobal('fetch', fetch);
    const r = await collectSerp(GOOGLE, { query: 'x' }, 10);
    expect(r.results).toHaveLength(10);
    expect(r.truncated).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('код 15 на первой странице → empty=true и пустой results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(errXml(15, 'ничего не найдено'))));
    const r = await collectSerp(GOOGLE, { query: 'x' }, 10);
    expect(r.empty).toBe(true);
    expect(r.results).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.found).toBeNull();
  });

  it('не-пустая выдача → empty=false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(serpXml(docXml(2)))));
    const r = await collectSerp(GOOGLE, { query: 'x' }, 2);
    expect(r.empty).toBe(false);
  });
});

describe('resolveLr', () => {
  it('резолвит имя и числовой id', () => {
    expect(resolveLr('Москва')).toBe(213);
    expect(resolveLr('225')).toBe(225);
  });

  it('текст ошибки указывает на инструмент xmlstock, а не чужого сервера', () => {
    expect(() => resolveLr('Атлантида')).toThrow(/xmlstock_wordstat_regions_tree/);
  });
});
