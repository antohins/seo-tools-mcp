import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ENV_FILE и снапшот process.env вычисляются при импорте shared/config.js —
// поэтому env выставляется ДО динамического импорта модуля (образец — tests/shared-config.test.ts).
// Временный env-файл делает тест герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let serp: typeof import('../servers/xmlriver/src/serp.js');
let verticals: typeof import('../servers/xmlriver/src/verticals.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-xmlriver-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'XMLRIVER_USER=u\nXMLRIVER_KEY=k\n', { mode: 0o600 });
  serp = await import('../servers/xmlriver/src/serp.js');
  verticals = await import('../servers/xmlriver/src/verticals.js');
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

const GOOGLE = 'https://xmlriver.com/search/xml';
const YANDEX = 'https://xmlriver.com/search_yandex/xml';

function fakeRes(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

/** XML-ошибка XMLRiver (HTTP 200 + <error code> в теле). */
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

/** Значение query-параметра из URL n-го вызова fetch. */
const fetchParam = (fetch: ReturnType<typeof vi.fn>, call: number, name: string) =>
  new URL(String(fetch.mock.calls[call][0])).searchParams.get(name);

describe('extractFound', () => {
  const docWithFound = (found: any) => ({ yandexsearch: { response: { found } } });

  it('выбирает found с priority="all" из нескольких', () => {
    const doc = docWithFound([
      { '@_priority': 'strict', '#text': '5' },
      { '@_priority': 'all', '#text': '1234' },
    ]);
    expect(serp.extractFound(doc)).toBe(1234);
  });

  it('фолбэк — первый found, если priority="all" нет', () => {
    const doc = docWithFound([
      { '@_priority': 'strict', '#text': '5' },
      { '@_priority': 'other', '#text': '9' },
    ]);
    expect(serp.extractFound(doc)).toBe(5);
  });

  it('легитимный 0 НЕ превращается в null', () => {
    expect(serp.extractFound(docWithFound({ '@_priority': 'all', '#text': '0' }))).toBe(0);
    expect(serp.extractFound(docWithFound('0'))).toBe(0);
  });

  it('found отсутствует/нечисловой → null', () => {
    expect(serp.extractFound({ yandexsearch: { response: {} } })).toBeNull();
    expect(serp.extractFound(docWithFound('abc'))).toBeNull();
  });
});

describe('xmlriverGet', () => {
  it('невалидный/HTML-ответ → понятная ошибка БЕЗ списания', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('<html><body>Authorization failed</body></html>')));
    await expect(serp.xmlriverGet(GOOGLE, { query: 'x' })).rejects.toThrow(/не-XML\/невалидный ответ/);
    expect(costTracked()).toBe(false);
  });

  it('yandexsearch без response → та же ошибка без списания', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('<?xml version="1.0"?><yandexsearch version="1.0"></yandexsearch>')));
    await expect(serp.xmlriverGet(GOOGLE, { query: 'x' })).rejects.toThrow(/не-XML\/невалидный ответ/);
    expect(costTracked()).toBe(false);
  });

  it('код 15 — валидная пустая выдача: doc возвращается, списание засчитано', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(errXml(15, 'По вашему запросу ничего не найдено'))));
    const doc = await serp.xmlriverGet(GOOGLE, { query: 'x' });
    expect(serp.isEmptySerp(doc)).toBe(true);
    expect(costTracked()).toBe(true);
  });

  it('код 202 — фатальная блокировка с понятным текстом, без ретраев', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(errXml(202, 'Временная блокировка')));
    vi.stubGlobal('fetch', fetch);
    await expect(serp.xmlriverGet(GOOGLE, { query: 'x' })).rejects.toThrow(/блокировка.*повторите запрос позже/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(costTracked()).toBe(false);
  });

  it.each([31, 42, 45, 200])('код %i — ошибка с подсказкой про ключи', async (code) => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(errXml(code, 'Ошибка авторизации')));
    vi.stubGlobal('fetch', fetch);
    await expect(serp.xmlriverGet(GOOGLE, { query: 'x' })).rejects.toThrow(/xmlriver_set_credentials/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(costTracked()).toBe(false);
  });

  it('код 500 — 2 ретрая (5с/10с), затем «исчерпаны ретраи (3 попытки)»', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockResolvedValue(fakeRes(errXml(500, 'Выполните перезапрос')));
      vi.stubGlobal('fetch', fetch);
      const p = serp.xmlriverGet(GOOGLE, { query: 'x' });
      const assertion = expect(p).rejects.toThrow('XMLRiver error 500: Выполните перезапрос — исчерпаны ретраи (3 попытки)');
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(costTracked()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('транзиентный код 20 — исчерпание ретраев с кодом и текстом последней попытки', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockResolvedValue(fakeRes(errXml(20, 'Поисковая система не ответила')));
      vi.stubGlobal('fetch', fetch);
      const p = serp.xmlriverGet(GOOGLE, { query: 'x' });
      const assertion = expect(p).rejects.toThrow('XMLRiver error 20: Поисковая система не ответила — исчерпаны ретраи (4 попытки)');
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
      const p = serp.xmlriverGet(GOOGLE, { query: 'x' });
      await vi.advanceTimersByTimeAsync(6_000);
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
  it('Google: страницы с 1, groupby не шлётся, truncated и сквозная нумерация', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(10), '<found priority="all">15</found>')))
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(5, 10))))
      .mockResolvedValueOnce(fakeRes(serpXml('')));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.collectSerp(GOOGLE, { query: 'x' }, 25);
    expect(r.results).toHaveLength(15);
    expect(r.truncated).toBe(true);
    expect(r.found).toBe(15);
    expect(r.results[14].position).toBe(15);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetchParam(fetch, 0, 'page')).toBe('1');
    expect(fetchParam(fetch, 1, 'page')).toBe('2');
    expect(fetchParam(fetch, 2, 'page')).toBe('3');
    expect(fetchParam(fetch, 0, 'groupby')).toBeNull();
  });

  it('Яндекс: страницы с 0', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(10))))
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(10, 10))))
      .mockResolvedValueOnce(fakeRes(serpXml('')));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.collectSerp(YANDEX, { query: 'x' }, 15);
    expect(r.results).toHaveLength(15);
    expect(r.truncated).toBe(false);
    expect(fetchParam(fetch, 0, 'page')).toBe('0');
    expect(fetchParam(fetch, 1, 'page')).toBe('1');
  });

  it('depth набран первой страницей → truncated=false, лишних запросов нет', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(serpXml(docXml(10), '<found priority="all">100</found>')));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.collectSerp(GOOGLE, { query: 'x' }, 10);
    expect(r.results).toHaveLength(10);
    expect(r.truncated).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('код 15 на первой странице → empty=true и пустой results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(errXml(15, 'ничего не найдено'))));
    const r = await serp.collectSerp(GOOGLE, { query: 'x' }, 10);
    expect(r.empty).toBe(true);
    expect(r.results).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.found).toBeNull();
  });

  it('флаг ai снимается с первой страницы', async () => {
    const xml = serpXml(docXml(2)).replace('<response>', '<response><ai><present>1</present></ai>');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(xml)));
    const r = await serp.collectSerp(GOOGLE, { query: 'x' }, 2);
    expect(r.ai).toBe(true);
  });

  it('aiOverview=true: ai=1 шлётся ТОЛЬКО на первой странице, обзор парсится', async () => {
    const html =
      '<html><body><p>Купить квартиру в Москве: цены от 5 млн.</p>' +
      '<a href="https://site-a.ru/flats">A</a><a href="https://site-b.ru/">B</a>' +
      '<a href="https://site-a.ru/flats">A-дубль</a><a href="https://support.google.com/x">G</a></body></html>';
    const b64 = Buffer.from(html, 'utf8').toString('base64');
    const page1 = serpXml(docXml(10)).replace('<response>', `<response><ai><present>1</present><answer>${b64}</answer></ai>`);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(page1))
      .mockResolvedValueOnce(fakeRes(serpXml(docXml(5, 10))));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.collectSerp(GOOGLE, { query: 'x' }, 15, undefined, true);
    expect(fetchParam(fetch, 0, 'ai')).toBe('1');
    expect(fetchParam(fetch, 1, 'ai')).toBeNull();
    expect(r.aiOverview).toBeDefined();
    expect(r.aiOverview!.present).toBe(true);
    expect(r.aiOverview!.available).toBe(true);
    expect(r.aiOverview!.text).toContain('Купить квартиру в Москве');
    expect(r.aiOverview!.links).toEqual(['https://site-a.ru/flats', 'https://site-b.ru/']);
  });

  it('без aiOverview параметр ai не отправляется и aiOverview не возвращается', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(serpXml(docXml(10))));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.collectSerp(GOOGLE, { query: 'x' }, 10);
    expect(fetchParam(fetch, 0, 'ai')).toBeNull();
    expect(r.aiOverview).toBeUndefined();
  });
});

describe('AI Overview (parse helpers)', () => {
  const aioDoc = (answer?: string) => ({
    yandexsearch: { response: { ai: { present: '1', ...(answer !== undefined ? { answer } : {}) } } },
  });
  const b64 = (html: string) => Buffer.from(html, 'utf8').toString('base64');

  it('decodeAiAnswer: base64 → HTML, мусор → пустая строка', () => {
    expect(serp.decodeAiAnswer(b64('<p>текст</p>'))).toBe('<p>текст</p>');
    expect(serp.decodeAiAnswer('')).toBe('');
    expect(serp.decodeAiAnswer(undefined)).toBe('');
    expect(serp.decodeAiAnswer(123)).toBe('');
  });

  it('extractAiLinks: дедуп, фильтр google-служебных, cap', () => {
    const html =
      '<a href="https://a.ru/1">1</a><a href="https://a.ru/1">дубль</a>' +
      '<a href="https://www.google.com/search?q=x">g</a><a href="https://accounts.google.com/s">g2</a>' +
      '<a href="https://b.ru/?x=1&amp;y=2">b</a><a href="/relative">r</a>';
    expect(serp.extractAiLinks(html)).toEqual(['https://a.ru/1', 'https://b.ru/?x=1&y=2']);
    const many = Array.from({ length: 40 }, (_, i) => `<a href="https://d${i}.ru/">x</a>`).join('');
    expect(serp.extractAiLinks(many)).toHaveLength(30);
  });

  it('extractAiText: strip tags + нормализация пробелов, cap с маркером обрезки', () => {
    expect(serp.extractAiText('<p>Раз <b>два</b></p>\n<p>три</p>')).toBe('Раз два три');
    const long = `<p>${'а'.repeat(5000)}</p>`;
    const text = serp.extractAiText(long);
    expect(text.length).toBeLessThan(4100);
    expect(text).toMatch(/… \[обрезано\]$/);
  });

  it('parseAiOverview: present+answer → available, текст и ссылки', () => {
    const doc = aioDoc(b64('<p>Обзор рынка.</p><a href="https://ex.ru/">ex</a>'));
    const r = serp.parseAiOverview(doc);
    expect(r).toEqual({ present: true, available: true, text: 'Обзор рынка. ex', links: ['https://ex.ru/'] });
  });

  it('parseAiOverview: «обзор недоступен» → available:false без text/links', () => {
    const doc = aioDoc(b64('<div>Для этого запроса обзор от ИИ недоступен.</div>'));
    expect(serp.parseAiOverview(doc)).toEqual({ present: true, available: false });
  });

  it('parseAiOverview: answer не пришёл → available:false; present=0 сохраняется', () => {
    expect(serp.parseAiOverview(aioDoc())).toEqual({ present: true, available: false });
    expect(serp.parseAiOverview({ yandexsearch: { response: {} } })).toEqual({ present: false, available: false });
  });
});

describe('collectVertical', () => {
  it('обрыв по пустой странице, страницы с 1, сквозная нумерация', async () => {
    const img = (n: number, offset = 0) =>
      Array.from(
        { length: n },
        (_, i) => `<doc><url>https://p${offset + i}.ru/</url><imgurl>https://p${offset + i}.ru/i.jpg</imgurl></doc>`,
      ).join('');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(serpXml(img(10))))
      .mockResolvedValueOnce(fakeRes(serpXml(img(10, 10))))
      .mockResolvedValueOnce(fakeRes(serpXml('')));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.collectVertical({ query: 'x', setab: 'images' }, 25, verticals.parseImages);
    expect(r.results).toHaveLength(20);
    expect(r.truncated).toBe(true);
    expect(r.results[19].position).toBe(20);
    expect(fetchParam(fetch, 0, 'page')).toBe('1');
    expect(fetchParam(fetch, 1, 'page')).toBe('2');
  });

  it('вертикаль с гео: loc/country/device=tablet уходят в URL запроса', async () => {
    const img = '<doc><url>https://p0.ru/</url><imgurl>https://p0.ru/i.jpg</imgurl></doc>';
    const fetch = vi.fn().mockResolvedValue(fakeRes(serpXml(img)));
    vi.stubGlobal('fetch', fetch);
    await serp.collectVertical({ query: 'x', setab: 'images', device: 'tablet', loc: 1011969, country: 2643 }, 5, verticals.parseImages);
    expect(fetchParam(fetch, 0, 'loc')).toBe('1011969');
    expect(fetchParam(fetch, 0, 'country')).toBe('2643');
    expect(fetchParam(fetch, 0, 'device')).toBe('tablet');
    expect(fetchParam(fetch, 0, 'setab')).toBe('images');
  });
});

describe('buildSerpParams', () => {
  const base = {
    query: 'x',
    device: 'desktop' as const,
    region: 'Москва',
    exactQuery: false,
    safeSearch: 'moderate' as const,
    includeAds: false,
  };

  it('yandex: шлём lr, НЕ шлём filter (safeSearch к Яндексу не применяется)', () => {
    const p = serp.buildSerpParams({ ...base, engine: 'yandex', safeSearch: 'strict' });
    expect(p.lr).toBe(213);
    expect(p.filter).toBeUndefined();
    expect(p.safe).toBeUndefined();
  });

  it('google: НЕ шлём lr (id региона Яндекса); moderate — no-op без safe', () => {
    const p = serp.buildSerpParams({ ...base, engine: 'google' });
    expect(p.lr).toBeUndefined();
    expect(p.safe).toBeUndefined();
  });

  it('google strict → safe=on, off → safe=off', () => {
    expect(serp.buildSerpParams({ ...base, engine: 'google', safeSearch: 'strict' }).safe).toBe('on');
    expect(serp.buildSerpParams({ ...base, engine: 'google', safeSearch: 'off' }).safe).toBe('off');
  });

  it('groupby не отправляется', () => {
    expect(serp.buildSerpParams({ ...base, engine: 'google' }).groupby).toBeUndefined();
    expect(serp.buildSerpParams({ ...base, engine: 'yandex' }).groupby).toBeUndefined();
  });

  it('device=tablet уходит в запрос как есть', () => {
    const p = serp.buildSerpParams({ ...base, engine: 'google', device: 'tablet' });
    expect(p.device).toBe('tablet');
  });

  it('os шлём только при device=mobile; при desktop/tablet — не шлём', () => {
    expect(serp.buildSerpParams({ ...base, engine: 'google', device: 'mobile', os: 'android' }).os).toBe('android');
    expect(serp.buildSerpParams({ ...base, engine: 'google', device: 'mobile', os: 'ios' }).os).toBe('ios');
    expect(serp.buildSerpParams({ ...base, engine: 'google', device: 'desktop', os: 'android' }).os).toBeUndefined();
    expect(serp.buildSerpParams({ ...base, engine: 'google', device: 'tablet', os: 'ios' }).os).toBeUndefined();
  });
});

describe('buildVerticalParams', () => {
  it('loc/country проходят в параметры (гео вертикалей Google)', () => {
    const p = serp.buildVerticalParams({ query: 'x', device: 'desktop', loc: 1011969, country: 2643 });
    expect(p.loc).toBe(1011969);
    expect(p.country).toBe(2643);
  });

  it('без гео loc/country отсутствуют; domain маппится в числовой id', () => {
    const p = serp.buildVerticalParams({ query: 'x', device: 'desktop' });
    expect(p.loc).toBeUndefined();
    expect(p.country).toBeUndefined();
    expect(p.domain).toBe(143);
  });

  it('device=tablet проходит; os — только при device=mobile', () => {
    expect(serp.buildVerticalParams({ query: 'x', device: 'tablet' }).device).toBe('tablet');
    expect(serp.buildVerticalParams({ query: 'x', device: 'mobile', os: 'ios' }).os).toBe('ios');
    expect(serp.buildVerticalParams({ query: 'x', device: 'tablet', os: 'android' }).os).toBeUndefined();
    expect(serp.buildVerticalParams({ query: 'x', device: 'desktop', os: 'android' }).os).toBeUndefined();
  });
});

describe('checkIndex', () => {
  it('engine=yandex → запрос идёт на YANDEX_URL, strict=false не шлётся', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(serpXml('<doc><url>https://ya.ru/</url><title>Я</title></doc>')));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.checkIndex('https://ya.ru/', 'yandex', false);
    expect(String(fetch.mock.calls[0][0])).toContain(YANDEX);
    expect(fetchParam(fetch, 0, 'inindex')).toBe('1');
    expect(fetchParam(fetch, 0, 'strict')).toBeNull();
    expect(r.indexed).toBe(true);
    expect(r.matchedUrl).toBe('https://ya.ru/');
  });

  it('engine=google + strict → strict=1, регистр учитывается', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(serpXml('<doc><url>https://ex.ru/Page</url><title>t</title></doc>')));
    vi.stubGlobal('fetch', fetch);
    const r = await serp.checkIndex('https://ex.ru/page', 'google', true);
    expect(String(fetch.mock.calls[0][0])).toContain(GOOGLE);
    expect(fetchParam(fetch, 0, 'strict')).toBe('1');
    expect(r.indexed).toBe(false); // регистр не совпал
  });

  it('query длиннее 1400 символов → ошибка валидации без запроса', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const long = `https://ex.ru/${'a'.repeat(1400)}`;
    await expect(serp.checkIndex(long, 'google', false)).rejects.toThrow(/1400/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('resolveLr', () => {
  it('резолвит имя и числовой id', () => {
    expect(serp.resolveLr('Москва')).toBe(213);
    expect(serp.resolveLr('225')).toBe(225);
  });

  it('текст ошибки указывает на wordstat-сервер, а не на инструмент xmlriver', () => {
    expect(() => serp.resolveLr('Атлантида')).toThrow(/wordstat_regions_tree сервера wordstat/);
  });
});
