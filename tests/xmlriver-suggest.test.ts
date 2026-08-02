import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ENV_FILE вычисляется при импорте shared/config.js — env выставляется ДО динамического
// импорта модуля (образец — tests/xmlriver-serp.test.ts). Временный env-файл делает тест
// герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let suggest: typeof import('../servers/xmlriver/src/suggest.js');
let serp: typeof import('../servers/xmlriver/src/serp.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-xmlriver-suggest-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'XMLRIVER_USER=u\nXMLRIVER_KEY=k\n', { mode: 0o600 });
  suggest = await import('../servers/xmlriver/src/suggest.js');
  serp = await import('../servers/xmlriver/src/serp.js');
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

/** n подсказок вида «фраза подсказка i». */
const tips = (phrase: string, n: number) => Array.from({ length: n }, (_, i) => `${phrase} подсказка ${i + 1}`);

let trackSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // глушим stderr-логи (cost/retry); trackSpy на общем cost-логгере из serp.ts — проверка списаний
  vi.spyOn(console, 'error').mockImplementation(() => {});
  trackSpy = vi.spyOn(serp.cost, 'track');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** URL n-го вызова fetch. */
const fetchUrl = (fetch: ReturnType<typeof vi.fn>, call = 0) => new URL(String(fetch.mock.calls[call][0]));

describe('collectSuggest', () => {
  it('успех 2×10: плоский список, группировка по фразам, charged=2, списание ×2', async () => {
    const phrases = ['купить квартиру', 'снять квартиру'];
    const fetch = vi.fn().mockResolvedValue(fakeRes(JSON.stringify({ phrases: [...tips(phrases[0], 10), ...tips(phrases[1], 10)] })));
    vi.stubGlobal('fetch', fetch);

    const r = await suggest.collectSuggest(phrases);
    expect(r.count).toBe(20);
    expect(r.charged).toBe(2);
    expect(r.phrases[0]).toBe('купить квартиру подсказка 1');
    expect(r.phrases[19]).toBe('снять квартиру подсказка 10');
    expect(r.byPhrase).toEqual({ 'купить квартиру': tips(phrases[0], 10), 'снять квартиру': tips(phrases[1], 10) });
    expect(r.note).toBeUndefined();
    // оплата за каждую фразу: один track с units=2
    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith('suggest (2 фраз)', 2);
  });

  it('POST на setab=tips с JSON-телом {"phrases":[...]}, user/key в URL', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(JSON.stringify({ phrases: tips('x', 10) })));
    vi.stubGlobal('fetch', fetch);

    await suggest.collectSuggest(['x']);
    const url = fetchUrl(fetch);
    expect(url.origin + url.pathname).toBe('https://xmlriver.com/search/xml');
    expect(url.searchParams.get('setab')).toBe('tips');
    expect(url.searchParams.get('user')).toBe('u');
    expect(url.searchParams.get('key')).toBe('k');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ phrases: ['x'] });
  });

  it('нечёткое число подсказок → byPhrase null + note, порядок сохранён', async () => {
    const phrases = ['a', 'b'];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(JSON.stringify({ phrases: [...tips('a', 10), ...tips('b', 5)] }))));

    const r = await suggest.collectSuggest(phrases);
    expect(r.count).toBe(15);
    expect(r.byPhrase).toBeNull();
    expect(r.note).toMatch(/группировка недоступна/);
    expect(r.phrases[14]).toBe('b подсказка 5');
  });

  it('JSON-ошибка code 3 → понятный throw БЕЗ списания', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(fakeRes(JSON.stringify({ code: '3', error: 'Ошибка парсинга JSON запроса или запрос пустой' }))),
    );
    await expect(suggest.collectSuggest(['x'])).rejects.toThrow('XMLRiver error 3: Ошибка парсинга JSON запроса или запрос пустой');
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('HTML-заглушка → ошибка «не-JSON» БЕЗ списания', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('<html><body>Authorization failed</body></html>')));
    await expect(suggest.collectSuggest(['x'])).rejects.toThrow(/не-JSON\/невалидный ответ/);
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('JSON без массива phrases → ошибка БЕЗ списания', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(JSON.stringify({ unexpected: true }))));
    await expect(suggest.collectSuggest(['x'])).rejects.toThrow(/не-JSON\/невалидный ответ/);
    expect(trackSpy).not.toHaveBeenCalled();
  });

  it('region → lr в URL; без region lr не шлётся', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes(JSON.stringify({ phrases: tips('x', 10) })));
    vi.stubGlobal('fetch', fetch);

    await suggest.collectSuggest(['x'], 'Москва');
    expect(fetchUrl(fetch, 0).searchParams.get('lr')).toBe('213');

    await suggest.collectSuggest(['x']);
    expect(fetchUrl(fetch, 1).searchParams.get('lr')).toBeNull();
  });

  it('HTTP 500 → HttpError после ретраев shared fetchText, БЕЗ списания', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn().mockResolvedValue(fakeRes('Server Error', 500));
      vi.stubGlobal('fetch', fetch);
      const p = suggest.collectSuggest(['x']);
      const assertion = expect(p).rejects.toThrow(/HTTP 500/);
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(3); // 3 попытки fetchText
      expect(trackSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('groupByPhrase', () => {
  it('равные чанки группируются по входным фразам', () => {
    const r = suggest.groupByPhrase(['a1', 'a2', 'b1', 'b2'], ['a', 'b']);
    expect(r).toEqual({ byPhrase: { a: ['a1', 'a2'], b: ['b1', 'b2'] } });
  });

  it('пустой ответ на непустой вход → пустые группы (0 делится нацело)', () => {
    expect(suggest.groupByPhrase([], ['a', 'b'])).toEqual({ byPhrase: { a: [], b: [] } });
  });

  it('неделимое число → null + note', () => {
    const r = suggest.groupByPhrase(['a1', 'a2', 'b1'], ['a', 'b']);
    expect(r.byPhrase).toBeNull();
    expect(r.note).toMatch(/группировка недоступна/);
  });
});

describe('suggestPhrasesSchema', () => {
  it('>50 фраз → ошибка zod', () => {
    expect(() => suggest.suggestPhrasesSchema.parse(Array.from({ length: 51 }, (_, i) => `ф${i}`))).toThrow(/50/);
  });

  it('пустой массив и пустая фраза → ошибка zod', () => {
    expect(() => suggest.suggestPhrasesSchema.parse([])).toThrow();
    expect(() => suggest.suggestPhrasesSchema.parse([''])).toThrow();
  });

  it('1–50 непустых фраз — валидно', () => {
    expect(suggest.suggestPhrasesSchema.parse(['x'])).toEqual(['x']);
    expect(suggest.suggestPhrasesSchema.parse(Array.from({ length: 50 }, (_, i) => `ф${i}`))).toHaveLength(50);
  });
});
