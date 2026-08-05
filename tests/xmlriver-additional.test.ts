import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ENV_FILE вычисляется при импорте shared/config.js — env выставляется ДО динамического
// импорта модулей (образец — tests/xmlriver-serp.test.ts). Тест герметичен: сеть мокнута.
let additional: typeof import('../servers/xmlriver/src/additional.js');
let serp: typeof import('../servers/xmlriver/src/serp.js');
let parseXml: typeof import('../shared/src/serp/xml.js').parseXml;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-xmlriver-add-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'XMLRIVER_USER=u\nXMLRIVER_KEY=k\n', { mode: 0o600 });
  additional = await import('../servers/xmlriver/src/additional.js');
  serp = await import('../servers/xmlriver/src/serp.js');
  parseXml = (await import('../shared/src/serp/xml.js')).parseXml;
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

const GOOGLE = 'https://xmlriver.com/search/xml';

const docXml = (n: number, offset = 0) =>
  Array.from({ length: n }, (_, i) => `<doc><url>https://site${offset + i}.ru/</url><title>t${offset + i}</title></doc>`).join('');

const serpXml = (docs: string) =>
  `<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><response><results><grouping><group>${docs}</group></grouping></results></response></yandexsearch>`;

/** Значение query-параметра из URL n-го вызова fetch. */
const fetchParam = (fetch: ReturnType<typeof vi.fn>, call: number, name: string) =>
  new URL(String(fetch.mock.calls[call][0])).searchParams.get(name);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Фикстура KG firm по лайв-структуре (2026-08): плоские поля + point + reviews + events.
const KG_FIRM_XML = `
  <knowledge_graph>
    <type>firm</type>
    <place_id>ChIJN1t_tDeuEmsRUsoyG83frY4</place_id>
    <name>Кофейня «Пример»</name>
    <rating>4.7</rating>
    <countReviews>1234</countReviews>
    <address>Москва, ул. Примерная, 1</address>
    <phone>+7 495 000-00-00</phone>
    <website>https://cafe.example.ru/</website>
    <category>Кофейня</category>
    <wiki></wiki>
    <description>Уютное место у метро</description>
    <timework>пн-пт 09:00–21:00</timework>
    <pricecategory>$$</pricecategory>
    <point lat="55.7558" lng="37.6173"/>
    <reviews>
      <item><link>https://maps.google.com/review/1</link><rating>5</rating></item>
      <item><link>https://maps.google.com/review/2</link><rating>4</rating></item>
    </reviews>
    <upComingEvents>
      <event><title>Вечер джаза</title><date>2026-09-01</date><url>https://cafe.example.ru/jazz</url></event>
    </upComingEvents>
  </knowledge_graph>`;

describe('parseKnowledgeGraph', () => {
  // разбор фикстуры тем же парсером, что в бою (fast-xml-parser из shared)
  const kgOf = (inner: string) => additional.parseKnowledgeGraph(parseXml(`<root>${inner}</root>`)?.root?.knowledge_graph);

  it('firm: все ключевые поля + координаты + отзывы + события', () => {
    const kg = kgOf(KG_FIRM_XML);
    expect(kg).toEqual({
      present: true,
      type: 'firm',
      place_id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
      name: 'Кофейня «Пример»',
      rating: 4.7,
      reviews_count: 1234,
      address: 'Москва, ул. Примерная, 1',
      phone: '+7 495 000-00-00',
      website: 'https://cafe.example.ru/',
      category: 'Кофейня',
      description: 'Уютное место у метро',
      working_hours: 'пн-пт 09:00–21:00',
      price_category: '$$',
      coordinates: { lat: 55.7558, lng: 37.6173 },
      reviews: [
        { link: 'https://maps.google.com/review/1', rating: 5 },
        { link: 'https://maps.google.com/review/2', rating: 4 },
      ],
      events: [{ title: 'Вечер джаза', date: '2026-09-01', url: 'https://cafe.example.ru/jazz' }],
    });
    expect(kg.empty).toBeUndefined();
  });

  it('person: birthdate/birthplace/wiki, без firm-полей', () => {
    const kg = kgOf(`
      <knowledge_graph>
        <type>person</type>
        <name>Иван Иванов</name>
        <birthdate>01.01.1980</birthdate>
        <birthplace>Москва</birthplace>
        <wiki>https://ru.wikipedia.org/wiki/Иванов</wiki>
        <description>Персона</description>
      </knowledge_graph>`);
    expect(kg.type).toBe('person');
    expect(kg.name).toBe('Иван Иванов');
    expect(kg.birthdate).toBe('01.01.1980');
    expect(kg.birthplace).toBe('Москва');
    expect(kg.wiki).toBe('https://ru.wikipedia.org/wiki/Иванов');
    expect(kg.address).toBeUndefined();
    expect(kg.empty).toBeUndefined();
  });

  it('все поля пустые (опция кабинета не включена) → present + empty', () => {
    const kg = kgOf(`
      <knowledge_graph>
        <type></type><place_id></place_id><name></name><rating></rating>
        <countReviews></countReviews><address></address><phone></phone>
        <website></website><category></category><wiki></wiki><description></description>
      </knowledge_graph>`);
    expect(kg).toEqual({ present: true, empty: true });
  });

  it('пустой элемент <knowledge_graph/> → тоже present + empty', () => {
    expect(additional.parseKnowledgeGraph('')).toEqual({ present: true, empty: true });
    expect(additional.parseKnowledgeGraph(null)).toEqual({ present: true, empty: true });
  });
});

describe('parseLocalResults / parseRelatedSearches / parseFaqSnippet', () => {
  it('localresultsplace: item → карточки карт', () => {
    const places = additional.parseLocalResults({
      item: [
        { title: 'Кофейня', place_id: 'ChIJ1', url: 'https://maps.google.com/?cid=1', rating: '4.5', thumbnail: 'https://img/1.jpg' },
        { title: 'Бар', place_id: 'ChIJ2', url: 'https://maps.google.com/?cid=2', rating: '4.2', thumbnail: '' },
      ],
    });
    expect(places).toEqual([
      { title: 'Кофейня', place_id: 'ChIJ1', url: 'https://maps.google.com/?cid=1', rating: 4.5, thumbnail: 'https://img/1.jpg' },
      { title: 'Бар', place_id: 'ChIJ2', url: 'https://maps.google.com/?cid=2', rating: 4.2 },
    ]);
  });

  it('relatedSearches: query/title → список строк; одиночный query — тоже массив', () => {
    expect(additional.parseRelatedSearches({ query: [{ title: 'купить квартиру' }, { title: 'аренда квартиры' }] })).toEqual([
      'купить квартиру',
      'аренда квартиры',
    ]);
    expect(additional.parseRelatedSearches({ query: { title: 'один запрос' } })).toEqual(['один запрос']);
    expect(additional.parseRelatedSearches('')).toEqual([]);
  });

  it('faqsnippet: item/{question,answer,url}; пустые item отбрасываются', () => {
    const faq = additional.parseFaqSnippet({
      item: [
        { question: 'Сколько стоит?', answer: 'От 100 ₽', url: 'https://ex.ru/faq' },
        { question: '', answer: '' },
      ],
    });
    expect(faq).toEqual([{ question: 'Сколько стоит?', answer: 'От 100 ₽', url: 'https://ex.ru/faq' }]);
  });
});

describe('parseAddResults', () => {
  const docOf = (addresults: any) => ({ yandexsearch: { response: { addresults } } });

  it('непришедшие блоки — в unavailable, пришедшие — разобраны', () => {
    const out = additional.parseAddResults(
      docOf({
        knowledge_graph: { type: 'firm', name: 'Кофейня' },
        relatedSearches: { query: { title: 'похожий запрос' } },
      }),
      ['knowledge_graph', 'localresultsplace', 'rs', 'faqsnippet'],
    );
    expect(out.knowledge_graph).toEqual({ present: true, type: 'firm', name: 'Кофейня' });
    expect(out.related_searches).toEqual(['похожий запрос']);
    expect(out.unavailable).toEqual(['localresultsplace', 'faqsnippet']);
    expect(out.local_results).toBeUndefined();
  });

  it('блок без детального парсинга → { present: true }', () => {
    const out = additional.parseAddResults(docOf({ topads: { some: 'data' }, g_news: '' }), ['topads', 'g_news', 'app']);
    expect(out.topads).toEqual({ present: true });
    expect(out.g_news).toEqual({ present: true }); // пустой элемент — пришёл
    expect(out.unavailable).toEqual(['app']);
  });

  it('addresults отсутствует вовсе → всё в unavailable; мусор не роняет парсер', () => {
    expect(additional.parseAddResults({ yandexsearch: { response: {} } }, ['rs', 'es']).unavailable).toEqual(['rs', 'es']);
    expect(additional.parseAddResults(docOf('строка вместо объекта'), ['knowledge_graph']).unavailable).toEqual(['knowledge_graph']);
    expect(additional.parseAddResults(docOf({ es: 123 }), ['es'])).toEqual({ es: { present: true } });
  });

  it('дубли в запрошенном списке не плодят повторы', () => {
    const out = additional.parseAddResults(docOf({}), ['rs', 'rs']);
    expect(out.unavailable).toEqual(['rs']);
  });
});

describe('collectSerp + additional', () => {
  it('additional= уходит ТОЛЬКО на первой странице, блоки парсятся из <addresults>', async () => {
    const page1 = serpXml(docXml(10)).replace('<response>', `<response><addresults>${KG_FIRM_XML}</addresults>`);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(page1))
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(5, 10))));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.collectSerp(GOOGLE, { query: 'x' }, 15, undefined, false, ['knowledge_graph', 'rs']);
    expect(fetchParam(fetch, 0, 'additional')).toBe('knowledge_graph,rs');
    expect(fetchParam(fetch, 1, 'additional')).toBeNull(); // пагинация без additional
    expect(r.additional?.knowledge_graph).toMatchObject({ present: true, type: 'firm', name: 'Кофейня «Пример»', rating: 4.7 });
    expect(r.additional?.unavailable).toEqual(['rs']);
  });

  it('без includeAdditional параметр не шлётся и поле не возвращается', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(serpXml(docXml(10))));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.collectSerp(GOOGLE, { query: 'x' }, 10);
    expect(fetchParam(fetch, 0, 'additional')).toBeNull();
    expect(r.additional).toBeUndefined();
  });

  it('связка с includeAIOverview: ai=1 и additional= вместе на первой странице, оба отсутствуют на второй', async () => {
    const b64 = Buffer.from('<p>Текст обзора.</p>', 'utf8').toString('base64');
    const page1 = serpXml(docXml(10)).replace(
      '<response>',
      `<response><ai><present>1</present><answer>${b64}</answer></ai><addresults>${KG_FIRM_XML}</addresults>`,
    );
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(page1))
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(5, 10))));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.collectSerp(GOOGLE, { query: 'x' }, 15, undefined, true, ['knowledge_graph']);
    expect(fetchParam(fetch, 0, 'ai')).toBe('1');
    expect(fetchParam(fetch, 0, 'additional')).toBe('knowledge_graph');
    expect(fetchParam(fetch, 1, 'ai')).toBeNull();
    expect(fetchParam(fetch, 1, 'additional')).toBeNull();
    expect(r.aiOverview?.available).toBe(true);
    expect(r.additional?.knowledge_graph).toMatchObject({ present: true, type: 'firm' });
  });

  // Яндекс: gating в index.ts (wantAdditional = isGoogle ? includeAdditional : undefined,
  // как wantAio) — index.ts поднимает сервер и в тестах не импортируется. Здесь фиксируем,
  // что через общие параметры additional не протекает ни для одного движка.
  it('buildSerpParams не содержит additional ни для google, ни для yandex', () => {
    const base = {
      query: 'x',
      device: 'desktop' as const,
      region: 'Москва',
      exactQuery: false,
      safeSearch: 'moderate' as const,
      includeAds: false,
    };
    expect(serp.buildSerpParams({ ...base, engine: 'yandex' }).additional).toBeUndefined();
    expect(serp.buildSerpParams({ ...base, engine: 'google' }).additional).toBeUndefined();
  });
});
