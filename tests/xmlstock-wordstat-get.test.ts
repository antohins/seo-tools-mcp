import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ENV_FILE и снапшот process.env вычисляются при импорте shared/config.js —
// поэтому env выставляется ДО динамического импорта модуля (образец — tests/ywm.test.ts).
// Временный env-файл делает тест герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let ws: typeof import('../servers/xmlstock/src/wordstat.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-xws-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'XMLSTOCK_USER=u1\nXMLSTOCK_KEY=k1\n', { mode: 0o600 });
  // защита от реального окружения процесса (initialEnv имеет приоритет над файлом)
  delete process.env.XMLSTOCK_USER;
  delete process.env.XMLSTOCK_KEY;
  ws = await import('../servers/xmlstock/src/wordstat.js');
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
  vi.spyOn(console, 'error').mockImplementation(() => {}); // глушим stderr-логи http-слоя и CostLogger
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('wordstatGet', () => {
  it('успех: отдаёт JSON, в URL — user/key/pagetype и параметры', async () => {
    const fetch = vi.fn(async () => fakeRes({ results: [{ phrase: 'окна', count: '100' }] }));
    vi.stubGlobal('fetch', fetch);
    const json = await ws.wordstatGet('words', { query: 'окна', regions: 213, empty: undefined });
    expect(json.results).toHaveLength(1);
    const url = String(fetch.mock.calls[0][0]);
    expect(url).toContain('pagetype=words');
    expect(url).toContain('user=u1');
    expect(url).toContain('key=k1');
    expect(url).toContain('regions=213');
    expect(url).not.toContain('empty=');
  });

  it('коды 100/200 — классификация как проблема авторизации (подсказка про ключи)', async () => {
    for (const code of [100, 200]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => fakeRes({ error: { code, message: 'denied' } })),
      );
      await expect(ws.wordstatGet('words', { query: 'x' })).rejects.toThrow(/error \d+: denied\. Проверьте XMLSTOCK_USER\/XMLSTOCK_KEY/);
      vi.unstubAllGlobals();
    }
  });

  it('прочий код, но текст про доступ — тоже подсказка про ключи; нейтральный код — без подсказки', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes({ error: { code: 7, message: 'access denied for key' } })),
    );
    await expect(ws.wordstatGet('words', { query: 'x' })).rejects.toThrow(/Проверьте XMLSTOCK_USER\/XMLSTOCK_KEY/);
    vi.unstubAllGlobals();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes({ error: { code: 7, message: 'invalid date range' } })),
    );
    await expect(ws.wordstatGet('words', { query: 'x' })).rejects.toThrow('XMLStock Wordstat error 7: invalid date range');
  });

  it('не-JSON ответ (HTML-заглушка) — подсказка про ключи', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => fakeRes('<html>Forbidden</html>')),
    );
    await expect(ws.wordstatGet('words', { query: 'x' })).rejects.toThrow(/вернул не JSON.*XMLSTOCK_USER\/XMLSTOCK_KEY/s);
  });

  it('HTTP 500 ретраится http-слоем: 500, 500, 200 → успех, 3 вызова fetch', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(fakeRes('boom', 500))
      .mockResolvedValueOnce(fakeRes('boom', 500))
      .mockResolvedValueOnce(fakeRes({ results: [] }));
    vi.stubGlobal('fetch', fetch);
    const json = await ws.wordstatGet('words', { query: 'x' });
    expect(json.results).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
  }, 15_000);
});
