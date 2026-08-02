import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// env выставляется ДО динамического импорта модуля (снапшот в shared/config.js при импорте);
// временный env-файл делает тест герметичным — реальный ~/.config/seo-tools-mcp/.env не читается.
let ws: typeof import('../servers/wordstat/src/wordstat.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-wordstat-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'WORDSTAT_API_KEY=k\nWORDSTAT_FOLDER_ID=f\n', { mode: 0o600 });
  ws = await import('../servers/wordstat/src/wordstat.js');
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

describe('hasOperators', () => {
  it.each(['"фраза"', '[фраза]', 'фраза]', '(a)', 'a)', 'a|b'])('«%s» — спецсимволы, операторы есть', (q) => {
    expect(ws.hasOperators(q)).toBe(true);
  });

  it.each(['!купить', 'купить -дёшево', 'купить +в москве', '-минус'])('«%s» — оператор в начале слова', (q) => {
    expect(ws.hasOperators(q)).toBe(true);
  });

  it.each(['санкт-петербург', 'купить квартиру', 'a-b c-d'])('«%s» — дефис ВНУТРИ слова, операторов нет', (q) => {
    expect(ws.hasOperators(q)).toBe(false);
  });
});

describe('exactForm', () => {
  it('оборачивает слова в "!слово !слово"', () => {
    expect(ws.exactForm('купить квартиру')).toBe('"!купить !квартиру"');
    expect(ws.exactForm('  одно  ')).toBe('"!одно"');
    expect(ws.exactForm('a  b   c')).toBe('"!a !b !c"');
  });

  it('фразу с готовыми операторами не трогаем (решает hasOperators до вызова)', () => {
    expect(ws.hasOperators('"!купить !квартиру"')).toBe(true);
  });
});

describe('toNum', () => {
  it('строки-int64 → number, мусор → 0', () => {
    expect(ws.toNum('12345')).toBe(12345);
    expect(ws.toNum('9007199254740991')).toBe(9007199254740991);
    expect(ws.toNum(42)).toBe(42);
    expect(ws.toNum(undefined)).toBe(0);
    expect(ws.toNum('abc')).toBe(0);
  });
});

describe('resolveDevices', () => {
  it('all/пусто → undefined (параметр не шлём)', () => {
    expect(ws.resolveDevices(undefined)).toBeUndefined();
    expect(ws.resolveDevices('all')).toBeUndefined();
  });

  it('список через запятую → enum API', () => {
    expect(ws.resolveDevices('desktop,phone')).toEqual(['DEVICE_DESKTOP', 'DEVICE_PHONE']);
    expect(ws.resolveDevices(' tablet ')).toEqual(['DEVICE_TABLET']);
  });

  it('неизвестное устройство → понятная ошибка', () => {
    expect(() => ws.resolveDevices('watch')).toThrow(/Неизвестное устройство «watch»/);
  });
});

describe('createRegionNamesCache', () => {
  const names = () => new Map([['213', 'Москва']]);

  it('дедупликация: параллельные вызовы на холодном кэше → 1 fetch', async () => {
    let resolveFetch: (m: Map<string, string>) => void;
    const gate = new Promise<Map<string, string>>((res) => {
      resolveFetch = res;
    });
    const fetchTree = vi.fn().mockReturnValue(gate);
    const cache = ws.createRegionNamesCache(fetchTree);
    const p = Promise.all([cache(), cache(), cache()]);
    resolveFetch!(names());
    const [a, b] = await p;
    expect(fetchTree).toHaveBeenCalledTimes(1);
    expect(a.get('213')).toBe('Москва');
    expect(b.get('213')).toBe('Москва');
  });

  it('в пределах TTL повторного fetch нет, после TTL — перечитывает', async () => {
    vi.useFakeTimers();
    try {
      const fetchTree = vi.fn().mockResolvedValue(names());
      const cache = ws.createRegionNamesCache(fetchTree, 1000);
      await cache();
      await cache();
      expect(fetchTree).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 1001);
      await cache();
      expect(fetchTree).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ошибка fetch не отравляет кэш: следующий вызов пробует снова', async () => {
    const fetchTree = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(names());
    const cache = ws.createRegionNamesCache(fetchTree);
    await expect(cache()).rejects.toThrow('boom');
    await expect(cache()).resolves.toBeInstanceOf(Map);
    expect(fetchTree).toHaveBeenCalledTimes(2);
  });
});

describe('validateDynamicsDates', () => {
  const now = new Date('2026-07-31T12:00:00Z');

  it('monthly: fromDate не 1-е число → понятная ошибка', () => {
    expect(() => ws.validateDynamicsDates('monthly', '2026-06-02', '2026-06-30', now)).toThrow(/monthly: fromDate должен быть 1-м числом/);
  });

  it('monthly: toDate не последний день месяца → ошибка', () => {
    expect(() => ws.validateDynamicsDates('monthly', '2026-06-01', '2026-06-29', now)).toThrow(
      /monthly: toDate должен быть последним днём месяца/,
    );
  });

  it('monthly: валидный диапазон проходит (включая февраль високосного года)', () => {
    expect(() => ws.validateDynamicsDates('monthly', '2026-06-01', '2026-06-30', now)).not.toThrow();
    expect(() => ws.validateDynamicsDates('monthly', '2024-02-01', '2024-02-29', now)).not.toThrow();
    expect(() => ws.validateDynamicsDates('monthly', '2026-02-01', '2026-02-28', now)).not.toThrow();
  });

  it('fromDate позже toDate → ошибка', () => {
    expect(() => ws.validateDynamicsDates('daily', '2026-07-30', '2026-07-29', now)).toThrow(/fromDate .* позже toDate/);
  });

  it('daily: глубже 60 дней → ошибка, ровно 60 — ок; граница считается по МСК, а не по UTC', () => {
    // 2026-07-31 22:30 UTC — по МСК уже 2026-08-01: 60 дней назад от неё = 2026-06-02
    const nowMskBoundary = new Date('2026-07-31T22:30:00Z');
    expect(() => ws.validateDynamicsDates('daily', '2026-06-01', '2026-07-30', nowMskBoundary)).toThrow(/последние 60 дней/);
    expect(() => ws.validateDynamicsDates('daily', '2026-06-02', '2026-07-30', nowMskBoundary)).not.toThrow();

    expect(() => ws.validateDynamicsDates('daily', '2026-05-31', '2026-07-30', now)).toThrow(/последние 60 дней/);
    expect(() => ws.validateDynamicsDates('daily', '2026-06-01', '2026-07-30', now)).not.toThrow();
  });

  it('weekly: fromDate не понедельник → ошибка; понедельник — ок', () => {
    expect(() => ws.validateDynamicsDates('weekly', '2026-07-28', '2026-08-02', now)).toThrow(/weekly: fromDate должен быть понедельником/);
    expect(() => ws.validateDynamicsDates('weekly', '2026-07-27', '2026-08-02', now)).not.toThrow();
  });
});

describe('wordstatPost — классификация ошибок', () => {
  it.each([401, 403])('HTTP %i → подсказка про ключи и роль, без ретраев', async (status) => {
    const fetch = vi.fn().mockResolvedValue(fakeRes('Unauthorized', status));
    vi.stubGlobal('fetch', fetch);
    await expect(ws.wordstatPost('topRequests', { phrase: 'x' })).rejects.toThrow(
      /WORDSTAT_API_KEY\/WORDSTAT_FOLDER_ID.*search-api\.webSearch\.user.*wordstat_set_credentials/s,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('финальный 429 (после ретраев) → подсказка про часовую квоту', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockResolvedValue(fakeRes('Too Many Requests', 429));
      vi.stubGlobal('fetch', fetch);
      const p = ws.wordstatPost('topRequests', { phrase: 'x' });
      const assertion = expect(p).rejects.toThrow(/квота Wordstat API.*100 запросов\/час/s);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(3); // fetchJson: 3 попытки на 429
    } finally {
      vi.useRealTimers();
    }
  });

  it('успех: folderId подмешивается в тело, Api-Key в заголовок', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes('{"totalCount":"7"}'));
    vi.stubGlobal('fetch', fetch);
    const r = await ws.wordstatPost<{ totalCount: string }>('topRequests', { phrase: 'x' });
    expect(r.totalCount).toBe('7');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Api-Key k');
    expect(JSON.parse(String(init.body))).toMatchObject({ folderId: 'f', phrase: 'x' });
  });
});
