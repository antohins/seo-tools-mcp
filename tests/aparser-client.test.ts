import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ENV_FILE и снапшот process.env вычисляются при импорте shared/config.js —
// поэтому env выставляется ДО динамического импорта модуля (образец — tests/xmlriver-serp.test.ts).
// Временный env-файл делает тест герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let client: typeof import('../servers/aparser/src/client.js');
let parse: typeof import('../servers/aparser/src/parse.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-aparser-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'APARSER_URL=http://127.0.0.1:9091/API\nAPARSER_PASSWORD=pw\n', { mode: 0o600 });
  client = await import('../servers/aparser/src/client.js');
  parse = await import('../servers/aparser/src/parse.js');
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

const okJson = (data: unknown) => JSON.stringify({ success: 1, data });
const errJson = (msg: string) => JSON.stringify({ success: 0, msg });

describe('aparserCall: классификация ошибок', () => {
  it('успех → json.data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(okJson({ pong: 1 }))));
    await expect(client.aparserCall('ping', {})).resolves.toEqual({ pong: 1 });
  });

  it.each(['Wrong password', 'Access denied', 'Доступ запрещён', 'неверный парол'])(
    'auth-ошибка «%s» → подсказка про APARSER_PASSWORD',
    async (msg) => {
      const fetch = vi.fn().mockResolvedValue(fakeRes(errJson(msg)));
      vi.stubGlobal('fetch', fetch);
      await expect(client.aparserCall('ping', {})).rejects.toThrow(/APARSER_PASSWORD.*aparser_set_credentials/);
    },
  );

  it('не-auth ошибка → generic без подсказки про пароль', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes(errJson('Unknown parser SE::Nope'))));
    await expect(client.aparserCall('oneRequest', {})).rejects.toThrow(/^A-Parser error: Unknown parser SE::Nope$/);
  });

  it('не-JSON ответ: фрагмент тела маскируется (key=value не светится)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeRes('<html>Authorization failed: password=supersecret9</html>')));
    const p = client.aparserCall('ping', {});
    await expect(p).rejects.toThrow(/не JSON/);
    await expect(p).rejects.toThrow(/password=REDACTED/);
    await expect(p).rejects.not.toThrow(/supersecret9/);
  });

  it('сетевая недоступность → адресация на aparser_ping/set_credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    await expect(client.aparserCall('ping', {})).rejects.toThrow(/aparser_ping.*aparser_set_credentials/);
  });

  it('attempts:1 (политика bulkRequest) — HTTP 500 без ретраев', async () => {
    const fetch = vi.fn().mockResolvedValue(fakeRes('Internal Server Error', 500));
    vi.stubGlobal('fetch', fetch);
    await expect(client.aparserCall('bulkRequest', {}, undefined, { attempts: 1 })).rejects.toThrow(/HTTP 500/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('buildOverrides / resolveExec', () => {
  it('buildOverrides: undefined/пустые пропускаются, boolean → 1/0', () => {
    expect(client.buildOverrides({ pagecount: 3, domain: undefined, hl: '', useproxy: true, proxyChecker: 'a,b' })).toEqual([
      { type: 'override', id: 'pagecount', value: '3' },
      { type: 'override', id: 'useproxy', value: '1' },
      { type: 'override', id: 'proxyChecker', value: 'a,b' },
    ]);
  });

  it('resolveExec: фолбэк на default без env/аргументов', () => {
    expect(client.resolveExec({}, 'APARSER_GOOGLE_PRESET')).toEqual({ preset: 'default', checkers: undefined, useProxy: true });
  });

  it('resolveExec: аргументы перекрывают дефолты', () => {
    expect(client.resolveExec({ preset: 'p1', checkers: ['x'], use_proxy: false }, 'APARSER_GOOGLE_PRESET')).toEqual({
      preset: 'p1',
      checkers: ['x'],
      useProxy: false,
    });
  });
});

describe('maskPresetOptions', () => {
  it('маскирует значения ключей pass|key|token|secret, остальное — как есть', () => {
    const out = client.maskPresetOptions({
      useproxy: '1',
      domain: 'google.com',
      proxy_password: 'supersecret9',
      apiKey: 'abcdef1234567890',
      token: 'tok',
    });
    expect(out.useproxy).toBe('1');
    expect(out.domain).toBe('google.com');
    expect(JSON.stringify(out)).not.toContain('supersecret9');
    expect(JSON.stringify(out)).not.toContain('abcdef1234567890');
    expect(JSON.stringify(out)).not.toContain('"tok"');
  });

  it('не-объект возвращается без изменений', () => {
    expect(client.maskPresetOptions(null)).toBeNull();
    expect(client.maskPresetOptions('x')).toBe('x');
  });
});

describe('resultsMarker: «success без results» ≠ пустая выдача', () => {
  it('нет results / пустой массив → results_present=false + note', () => {
    for (const data of [{}, { results: [] }, null]) {
      const m = parse.resultsMarker(data);
      expect(m.results_present).toBe(false);
      expect(m.note).toMatch(/НЕ легитимная пустая выдача/);
    }
  });

  it('results[0] с пустым serp — легитимная пустая выдача → true, без note', () => {
    const m = parse.resultsMarker({ results: [{ query: 'q', serp: [] }] });
    expect(m).toEqual({ results_present: true });
  });
});

describe('normalizeBulkResults: нормализация только для SERP-парсеров', () => {
  const raw = [{ query: { query: 'q' }, success: 1, serp: [{ link: 'https://x.ru', anchor: 'X' }], custom: 'keep' }];

  it('SE::Google/SE::Yandex → parseSerpResult', () => {
    for (const p of ['SE::Google', 'SE::Yandex']) {
      const out = parse.normalizeBulkResults(p, raw, true);
      expect(out[0].serp[0]).toEqual({ position: 1, url: 'https://x.ru', anchor: 'X', snippet: '' });
      expect(out[0].custom).toBeUndefined();
    }
  });

  it('прочие парсеры (SE::Google::Suggest, Net::HTTP) → результаты как есть', () => {
    for (const p of ['SE::Google::Suggest', 'SE::Yandex::Wordstat', 'Net::HTTP']) {
      expect(parse.normalizeBulkResults(p, raw, true)).toBe(raw);
    }
  });

  it('raw=false → как есть даже для SERP-парсера', () => {
    expect(parse.normalizeBulkResults('SE::Google', raw, false)).toBe(raw);
  });
});

describe('capProxies', () => {
  it('список обрезается до 100, count полный, truncated=true', () => {
    const proxies = Array.from({ length: 150 }, (_, i) => ({ address: `10.0.0.${i}:8080`, type: 'http' }));
    const out = parse.capProxies({ count: 150, byType: { http: 150 }, proxies });
    expect(out.count).toBe(150);
    expect(out.proxies).toHaveLength(100);
    expect(out.truncated).toBe(true);
    expect(out.byType).toEqual({ http: 150 });
  });

  it('меньше лимита → truncated=false, список полный', () => {
    const out = parse.capProxies({
      count: 2,
      byType: { http: 2 },
      proxies: [
        { address: 'a', type: 'http' },
        { address: 'b', type: 'http' },
      ],
    });
    expect(out.truncated).toBe(false);
    expect(out.proxies).toHaveLength(2);
  });
});
