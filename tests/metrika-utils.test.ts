import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// env выставляется ДО динамического импорта модуля (снапшот в shared/config.js при импорте);
// временный env-файл делает тест герметичным — реальный ~/.config/seo-tools-mcp/.env не читается.
let u: typeof import('../servers/metrika/src/utils.js');
let paginate: typeof import('../servers/metrika/src/paginate.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-metrika-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'METRIKA_OAUTH_TOKEN=t\nMETRIKA_COUNTER_ID=12345\n', { mode: 0o600 });
  u = await import('../servers/metrika/src/utils.js');
  paginate = await import('../servers/metrika/src/paginate.js');
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fakeRes(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

describe('metrikaDates — «сегодня» по МСК', () => {
  it('ночь по UTC, но уже завтра по МСК → date2 завтрашняя', () => {
    // 22:30 UTC = 01:30 МСК следующих суток
    const { date1, date2 } = u.metrikaDates(undefined, undefined, 30, Date.parse('2026-07-31T22:30:00Z'));
    expect(date2).toBe('2026-08-01');
    expect(date1).toBe('2026-07-02');
  });

  it('день по UTC — та же дата по МСК', () => {
    const { date2 } = u.metrikaDates(undefined, undefined, 30, Date.parse('2026-07-31T12:00:00Z'));
    expect(date2).toBe('2026-07-31');
  });

  it('граница 21:00 UTC = полночь МСК', () => {
    const { date2 } = u.metrikaDates(undefined, undefined, 30, Date.parse('2026-07-31T21:00:00Z'));
    expect(date2).toBe('2026-08-01');
  });

  it('явные даты не трогаем', () => {
    expect(u.metrikaDates('2026-01-01', '2026-01-31', 30)).toEqual({ date1: '2026-01-01', date2: '2026-01-31' });
  });
});

describe('validateDateRange', () => {
  it('date1 позже date2 → понятная ошибка', () => {
    expect(() => u.validateDateRange('2026-07-30', '2026-07-01')).toThrow(/date1 \(2026-07-30\) позже date2 \(2026-07-01\)/);
  });

  it('кастомные метки (startDate/endDate)', () => {
    expect(() => u.validateDateRange('2026-07-30', '2026-07-01', 'startDate', 'endDate')).toThrow(/startDate .* позже endDate/);
  });

  it('равные и правильный порядок — ок', () => {
    expect(() => u.validateDateRange('2026-07-01', '2026-07-01')).not.toThrow();
    expect(() => u.validateDateRange('2026-07-01', '2026-07-30')).not.toThrow();
  });
});

describe('accuracyError — валидация accuracy', () => {
  it.each(['low', 'medium', 'high', 'full', 'FULL', ' 0.1 ', '0.5', '1'])('«%s» — валидно', (v) => {
    expect(u.accuracyError(v)).toBeNull();
  });

  it.each(['auto', '0', '-0.5', '1.5', 'foo', ''])('«%s» — ошибка с допустимыми значениями', (v) => {
    expect(u.accuracyError(v)).toMatch(/low \| medium \| high \| full/);
  });

  it('сообщение включает полученное значение', () => {
    expect(u.accuracyError('auto')).toContain('«auto»');
  });
});

describe('resolveCounterId', () => {
  it('явный override побеждает', () => {
    expect(u.resolveCounterId(777)).toBe('777');
  });

  it('дефолт из конфига', () => {
    expect(u.resolveCounterId(undefined)).toBe('12345');
  });

  it('нет счётчика у профиля → ошибка с подсказками, без тихого фолбэка', () => {
    expect(() => u.resolveCounterId(undefined, 'ghost')).toThrow(/metrika_set_credentials.*metrika_counters/s);
  });
});

describe('statQuery — форма ответа и классификация ошибок', () => {
  it('data не массив → понятная ошибка вместо TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('{"totals":[1,2,3]}')));
    await expect(u.statQuery({ ids: '1' })).rejects.toThrow(/Неожиданный формат ответа Метрики.*data не массив/);
  });

  it('403 → подсказка про доступ, metrika_counters и METRIKA_COUNTER_ID', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes('Forbidden', 403));
    vi.stubGlobal('fetch', fetch);
    await expect(u.statQuery({ ids: '1' })).rejects.toThrow(/нет доступа к счётчику.*metrika_counters.*METRIKA_COUNTER_ID/s);
    expect(fetch).toHaveBeenCalledTimes(1); // 403 не ретраится
  });

  it('404 → «счётчик не найден» с подсказками', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('Not found', 404)));
    await expect(u.statQuery({ ids: '1' })).rejects.toThrow(/счётчик не найден.*metrika_counters/s);
  });

  it('успех: querystring собран, пустые параметры не шлются', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes('{"data":[{"dimensions":[{"name":"x"}],"metrics":[1]}],"total_rows":1}'));
    vi.stubGlobal('fetch', fetch);
    const res = await u.statQuery({ ids: '1', metrics: 'ym:s:visits', filters: undefined, sort: '' });
    expect(res.data).toHaveLength(1);
    const url = new URL(String(fetch.mock.calls[0][0]));
    expect(url.searchParams.get('ids')).toBe('1');
    expect(url.searchParams.get('metrics')).toBe('ym:s:visits');
    expect(url.searchParams.has('filters')).toBe(false);
    expect(url.searchParams.has('sort')).toBe(false);
  });
});

describe('collectAllPages — форма ответа', () => {
  it('data не массив на первой странице → понятная ошибка', async () => {
    const api = async () => ({ totals: [1] }) as unknown as paginate.StatResponse;
    await expect(paginate.collectAllPages(api, 100, 5)).rejects.toThrow(/Неожиданный формат ответа Метрики/);
  });

  it('data не массив на второй странице → понятная ошибка', async () => {
    const api = async (offset: number): Promise<paginate.StatResponse> =>
      offset === 1
        ? { data: [{ dimensions: [{ name: 'a' }], metrics: [1] }], total_rows: 5 }
        : ({ message: 'oops' } as unknown as paginate.StatResponse);
    await expect(paginate.collectAllPages(api, 100, 5)).rejects.toThrow(/Неожиданный формат ответа Метрики/);
  });
});

describe('createGoalsCache', () => {
  const goals = (n: number) => [{ id: n, name: `g${n}` }];

  it('дедупликация: параллельные вызовы на холодном кэше → 1 fetch', async () => {
    let resolveFetch: (g: u.Goal[]) => void;
    const gate = new Promise<u.Goal[]>((res) => {
      resolveFetch = res;
    });
    const fetcher = vi.fn().mockReturnValue(gate);
    const cache = u.createGoalsCache(fetcher);
    const p = Promise.all([cache('1'), cache('1'), cache('1')]);
    resolveFetch!(goals(7));
    const [a, b] = await p;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a[0].name).toBe('g7');
    expect(b).toEqual(a);
  });

  it('ключ — account + counterId: разные аккаунты и счётчики кэш не делят', async () => {
    const fetcher = vi.fn().mockResolvedValue(goals(1));
    const cache = u.createGoalsCache(fetcher);
    await cache('1', 'accA');
    await cache('1', 'accB');
    await cache('2', 'accA');
    await cache('1', 'accA'); // повтор — из кэша
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('в пределах TTL повторного fetch нет, после TTL — перечитывает', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue(goals(1));
      const cache = u.createGoalsCache(fetcher, 1000);
      await cache('1');
      await cache('1');
      expect(fetcher).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 1001);
      await cache('1');
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ошибка fetch не отравляет кэш: следующий вызов пробует снова', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(goals(1));
    const cache = u.createGoalsCache(fetcher);
    await expect(cache('1')).rejects.toThrow('boom');
    await expect(cache('1')).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('clipGoalIds — обрезка целей с маркерами', () => {
  it('12 целей → 10 + truncated/dropped', () => {
    const r = u.clipGoalIds(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(r.goalIds).toHaveLength(10);
    expect(r.truncated).toBe(true);
    expect(r.dropped).toBe(2);
  });

  it('в пределах лимита — без маркеров', () => {
    const r = u.clipGoalIds([1, 2, 3]);
    expect(r).toEqual({ goalIds: [1, 2, 3], truncated: false, dropped: 0 });
  });
});

describe('mapLandingTotals — единицы bounceRate и маппинг целей', () => {
  it('bounceRate — проценты как у Метрики (без деления на 100)', () => {
    const t = u.mapLandingTotals([100, 80, 12.5, 2.3, 145, 7, 3], [11, 22], new Map([[11, 'Заявка']]));
    expect(t.bounceRate).toBe(12.5); // процент (0–100), консистентно с metrika_report
    expect(t.visits).toBe(100);
    expect(t.pageDepth).toBe(2.3);
    expect(t.avgVisitDurationSeconds).toBe(145);
    expect(t.goalReaches).toEqual({ 'Заявка (#11)': 7, goal_22: 3 });
  });

  it('пустые totals → нули', () => {
    const t = u.mapLandingTotals([], [5], new Map());
    expect(t.visits).toBe(0);
    expect(t.bounceRate).toBe(0);
    expect(t.goalReaches).toEqual({ goal_5: 0 });
  });
});

describe('isTruncated / sampleShareField', () => {
  it('truncated — только когда total_rows больше фактически возвращённых', () => {
    expect(u.isTruncated(100, 50)).toBe(true);
    expect(u.isTruncated(50, 50)).toBe(false);
    expect(u.isTruncated(undefined, 50)).toBe(false);
  });

  it('sample_share — только при sampled:true', () => {
    expect(u.sampleShareField({ sampled: true, sample_share: 0.1 })).toEqual({ sample_share: 0.1 });
    expect(u.sampleShareField({ sampled: true })).toEqual({ sample_share: null });
    expect(u.sampleShareField({ sampled: false, sample_share: 0.1 })).toEqual({});
    expect(u.sampleShareField({})).toEqual({});
  });
});
