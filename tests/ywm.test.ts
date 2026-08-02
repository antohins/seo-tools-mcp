import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ENV_FILE и снапшот process.env вычисляются при импорте shared/config.js —
// поэтому env выставляется ДО динамического импорта модуля (образец — tests/xmlriver-serp.test.ts).
// Временный env-файл делает тест герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let q: typeof import('../servers/ywm/src/queries.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-ywm-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'YANDEX_OAUTH_TOKEN=tok\nYWM_HOST_ID=https:example.com:443\n', { mode: 0o600 });
  q = await import('../servers/ywm/src/queries.js');
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

function fakeRes(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {}); // глушим stderr-логи http-слоя
  q.clearUserIdCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getUserId', () => {
  it('числовой user_id → строка, повторный вызов — из кэша (1 fetch)', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes({ user_id: 12345 }));
    vi.stubGlobal('fetch', fetch);
    expect(await q.getUserId()).toBe('12345');
    expect(await q.getUserId()).toBe('12345');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('user_id строкой цифр — принимается', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes({ user_id: '777' })));
    expect(await q.getUserId()).toBe('777');
  });

  it('нечисловой user_id → понятная ошибка, в кеш НЕ кладётся (ретрай идёт в API снова)', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes({ user_id: 'abc' }));
    vi.stubGlobal('fetch', fetch);
    await expect(q.getUserId()).rejects.toThrow(/Неожиданный ответ \/user\//);
    await expect(q.getUserId()).rejects.toThrow(/Неожиданный ответ \/user\//);
    expect(fetch).toHaveBeenCalledTimes(2); // не закешировалось
  });

  it('отсутствующий user_id → та же ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes({})));
    await expect(q.getUserId()).rejects.toThrow(/Неожиданный ответ \/user\//);
  });

  it('дедупликация in-flight: два параллельных вызова при холодном кэше → 1 fetch', async () => {
    const fetch = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return fakeRes({ user_id: 42 });
    });
    vi.stubGlobal('fetch', fetch);
    const [a, b] = await Promise.all([q.getUserId(), q.getUserId()]);
    expect(a).toBe('42');
    expect(b).toBe('42');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('классификация ошибок API', () => {
  it('403 → подсказка про hostId (ywm_hosts) и переавторизацию (ywm_oauth_start)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('Forbidden', 403)));
    await expect(q.ywmGet('/user/1/hosts/x/summary')).rejects.toThrow(/ywm_hosts.*ywm_oauth_start/s);
  });

  it('404 → «хост не найден» с форматом hostId и ywm_hosts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('Not Found', 404)));
    await expect(q.ywmGet('/user/1/hosts/x/summary')).rejects.toThrow(/хост не найден.*https:example\.com:443.*ywm_hosts/s);
  });
});

describe('aggregate', () => {
  it('сворачивает дни: суммы показов/кликов/спроса, ctr, средняя позиция с округлением', () => {
    const r = q.aggregate([
      { date: '2026-07-01', field: 'IMPRESSIONS', value: 100 },
      { date: '2026-07-02', field: 'IMPRESSIONS', value: 50 },
      { date: '2026-07-01', field: 'CLICKS', value: 10 },
      { date: '2026-07-02', field: 'CLICKS', value: 5 },
      { date: '2026-07-01', field: 'DEMAND', value: 200 },
      { date: '2026-07-01', field: 'POSITION', value: 5 },
      { date: '2026-07-02', field: 'POSITION', value: 6.5 },
    ]);
    expect(r).toEqual({ shows: 150, clicks: 15, ctr: 0.1, position: 5.8, demand: 200 });
  });

  it('без POSITION-статистики позиция — null; без показов ctr = 0', () => {
    const r = q.aggregate([{ date: '2026-07-01', field: 'CLICKS', value: 3 }]);
    expect(r.position).toBeNull();
    expect(r.ctr).toBe(0);
  });
});

describe('sortQueries', () => {
  const rows = [
    { query: 'a', shows: 10, clicks: 1, ctr: 0.1, position: null, demand: 0 },
    { query: 'b', shows: 20, clicks: 5, ctr: 0.25, position: 3, demand: 0 },
    { query: 'c', shows: 5, clicks: 0, ctr: 0, position: 12, demand: 0 },
  ];

  it('POSITION — по возрастанию, null-позиции в конец', () => {
    expect(q.sortQueries(rows, 'POSITION').map((r) => r.query)).toEqual(['b', 'c', 'a']);
  });

  it('IMPRESSIONS — по убыванию, null-позиции не мешают', () => {
    expect(q.sortQueries(rows, 'IMPRESSIONS').map((r) => r.query)).toEqual(['b', 'a', 'c']);
  });
});

describe('dateRange / validateDateOrder', () => {
  // 2026-07-31 22:30 UTC — по МСК уже 2026-08-01 01:30
  const now = Date.UTC(2026, 6, 31, 22, 30);

  it('дефолты считаются по МСК, а не по UTC', () => {
    expect(q.todayMsk(now)).toBe('2026-08-01');
    expect(q.dateRange(undefined, undefined, 30, now)).toEqual({ date_from: '2026-07-02', date_to: '2026-08-01' });
  });

  it('явные даты проходят как есть', () => {
    expect(q.dateRange('2026-01-10', '2026-02-01', 30, now)).toEqual({ date_from: '2026-01-10', date_to: '2026-02-01' });
  });

  it('from > to → понятная ошибка (и внутри dateRange тоже)', () => {
    expect(() => q.validateDateOrder('2026-02-01', '2026-01-10')).toThrow(/dateFrom \(2026-02-01\) позже dateTo \(2026-01-10\)/);
    expect(() => q.dateRange('2026-02-01', '2026-01-10', 30, now)).toThrow(/позже dateTo/);
    expect(() => q.validateDateOrder('2026-01-10', '2026-02-01')).not.toThrow();
  });
});

describe('resolveHost', () => {
  it('явный hostId валидного формата проходит', () => {
    expect(q.resolveHost('https:site.ru:443')).toBe('https:site.ru:443');
    expect(q.resolveHost('http:site.ru:80')).toBe('http:site.ru:80');
  });

  it('дефолт — YWM_HOST_ID из конфига', () => {
    expect(q.resolveHost()).toBe('https:example.com:443');
  });

  it('битый формат → ошибка с правильным форматом и ywm_hosts', () => {
    expect(() => q.resolveHost('https://site.ru/')).toThrow(/Некорректный hostId.*https:example\.com:443.*ywm_hosts/s);
    expect(() => q.resolveHost('site.ru')).toThrow(/Некорректный hostId/);
  });

  it('пусто и в конфиге нет → «Не указан хост» с подсказками', () => {
    // без аккаунта читаем YWM_HOST_ID из конфига; для холодного кейса — несуществующий профиль
    expect(() => q.resolveHost(undefined, 'no-such-account')).toThrow(/Не указан хост Вебмастера.*ywm_set_credentials.*ywm_hosts/s);
  });
});

describe('filterRecommended', () => {
  const mk = (over: Partial<q.QueryRow>): q.QueryRow => ({ query: 'x', shows: 0, clicks: 0, ctr: 0, position: null, demand: 0, ...over });

  it('три категории reason: показы без кликов / позиция за топ-10 / есть спрос', () => {
    const rows = [
      mk({ query: 'показы-без-кликов', shows: 100, clicks: 0 }),
      mk({ query: 'за-топ-10', shows: 50, clicks: 2, position: 15 }),
      mk({ query: 'есть-спрос', demand: 300 }),
      mk({ query: 'всё-хорошо', shows: 10, clicks: 5, position: 3, demand: 0 }),
    ];
    const out = q.filterRecommended(rows, 100);
    expect(out.find((r) => r.query === 'показы-без-кликов')?.reason).toBe('показы без кликов');
    expect(out.find((r) => r.query === 'за-топ-10')?.reason).toBe('позиция за топ-10');
    expect(out.find((r) => r.query === 'есть-спрос')?.reason).toBe('есть спрос');
    expect(out.find((r) => r.query === 'всё-хорошо')).toBeUndefined();
  });

  it('приоритет reason: показы без кликов важнее позиции, позиция важнее спроса', () => {
    const out = q.filterRecommended([mk({ query: 'x', shows: 10, clicks: 0, position: 20, demand: 5 })], 100);
    expect(out[0].reason).toBe('показы без кликов');
  });

  it('сортировка по спросу, затем по показам; limit режет', () => {
    const rows = [
      mk({ query: 'a', demand: 10, shows: 5 }),
      mk({ query: 'b', demand: 100, shows: 1 }),
      mk({ query: 'c', demand: 10, shows: 50 }),
    ];
    expect(q.filterRecommended(rows, 100).map((r) => r.query)).toEqual(['b', 'c', 'a']);
    expect(q.filterRecommended(rows, 2)).toHaveLength(2);
  });
});

describe('validateOptionalDateOrder (безусловная валидация порядка дат)', () => {
  const now = Date.UTC(2026, 6, 31, 22, 30); // по МСК — 2026-08-01

  it('одиночный dateFrom в будущем (позже «сегодня» по МСК) → понятная ошибка', () => {
    expect(() => q.validateOptionalDateOrder('2026-08-02', undefined, now)).toThrow(/dateFrom \(2026-08-02\) позже dateTo \(2026-08-01\)/);
  });

  it('одиночный dateFrom в прошлом/сегодня — ок; одиночный dateTo — всегда ок', () => {
    expect(() => q.validateOptionalDateOrder('2026-08-01', undefined, now)).not.toThrow();
    expect(() => q.validateOptionalDateOrder('2020-01-01', undefined, now)).not.toThrow();
    expect(() => q.validateOptionalDateOrder(undefined, '2020-01-01', now)).not.toThrow();
    expect(() => q.validateOptionalDateOrder(undefined, undefined, now)).not.toThrow();
  });

  it('обе даты: from > to → ошибка, from <= to — ок', () => {
    expect(() => q.validateOptionalDateOrder('2026-02-01', '2026-01-10', now)).toThrow(/позже dateTo/);
    expect(() => q.validateOptionalDateOrder('2026-01-10', '2026-02-01', now)).not.toThrow();
  });
});

describe('fetchPopular (пагинация search-queries/popular)', () => {
  const popularPage = (texts: string[]) => ({
    queries: texts.map((t) => ({ query_text: t, indicators: { TOTAL_SHOWS: 10, TOTAL_CLICKS: 2, AVG_SHOW_POSITION: 5.5 } })),
  });
  /** fetch: /user/ → user_id; popular — страницы по очереди из массива. */
  const stubPopular = (pages: Array<ReturnType<typeof popularPage>>) => {
    let pageIdx = 0;
    const fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/user/')) return fakeRes({ user_id: 1 });
      expect(url).toContain('/search-queries/popular');
      return fakeRes(pages[pageIdx++] ?? { queries: [] });
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('обрыв по короткой странице: данных больше нет → truncated=false', async () => {
    const fetch = stubPopular([popularPage(['a', 'b', 'c'])]);
    const { rows, truncated } = await q.fetchPopular('https:example.com:443', { orderBy: 'TOTAL_SHOWS', device: 'ALL', limit: 10 });
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(false);
    expect(rows[0]).toEqual({ query: 'a', shows: 10, clicks: 2, avg_show_position: 5.5, avg_click_position: null });
    expect(fetch).toHaveBeenCalledTimes(2); // /user/ + одна страница popular
  });

  it('набрали ровно limit → truncated=true (за ним могли остаться строки)', async () => {
    stubPopular([popularPage(['a', 'b', 'c'])]);
    const { rows, truncated } = await q.fetchPopular('https:example.com:443', { orderBy: 'TOTAL_SHOWS', device: 'ALL', limit: 3 });
    expect(rows).toHaveLength(3);
    expect(truncated).toBe(true);
  });

  it('многостраничный добор: 500 + короткая → truncated=false; даты попадают в query', async () => {
    const big = popularPage(Array.from({ length: 500 }, (_, i) => `q${i}`));
    const fetch = stubPopular([big, popularPage(['x', 'y'])]);
    const { rows, truncated } = await q.fetchPopular('https:example.com:443', {
      orderBy: 'TOTAL_CLICKS',
      device: 'DESKTOP',
      limit: 600,
      dateFrom: '2026-07-01',
      dateTo: '2026-07-07',
    });
    expect(rows).toHaveLength(502);
    expect(truncated).toBe(false);
    const urls = fetch.mock.calls.map(([u]) => String(u));
    expect(urls[1]).toContain('offset=0');
    expect(urls[1]).toContain('date_from=2026-07-01');
    expect(urls[1]).toContain('date_to=2026-07-07');
    expect(urls[2]).toContain('offset=500');
  });
});
