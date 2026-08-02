import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// config.js читает окружение снапшотом при импорте — выставляем env ДО динамического импорта.
let dir: string;
let oauth: typeof import('../shared/src/yandex-oauth.js');

function fakeJson(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-oauth-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  process.env.YANDEX_OAUTH_TOKEN = 'old-token';
  process.env.YANDEX_REFRESH_TOKEN = 'refresh-1';
  process.env.YANDEX_CLIENT_ID = 'cid';
  process.env.YANDEX_CLIENT_SECRET = 'cs';
  oauth = await import('../shared/src/yandex-oauth.js');
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SEO_TOOLS_MCP_ENV;
  delete process.env.YANDEX_OAUTH_TOKEN;
  delete process.env.YANDEX_REFRESH_TOKEN;
  delete process.env.YANDEX_CLIENT_ID;
  delete process.env.YANDEX_CLIENT_SECRET;
  rmSync(dir, { recursive: true, force: true });
});

describe('yandex-oauth: дедупликация параллельных refresh', () => {
  it('два параллельных 401 → один обмен токена, оба вызова получают новый токен', async () => {
    let exchanges = 0;
    const fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes('oauth.yandex.ru/token')) {
        exchanges++;
        // задержка обмена — чтобы второй вызов гарантированно зашёл в refresh до конца первого
        await new Promise((r) => setTimeout(r, 20));
        return fakeJson(200, { access_token: 'new-token', refresh_token: 'refresh-2', expires_in: 3600 });
      }
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return auth === 'OAuth new-token' ? fakeJson(200, { ok: true }) : fakeJson(401, { error: 'unauthorized' });
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const [a, b] = await Promise.all([
      oauth.yandexFetchJson('YWM_OAUTH_TOKEN', 'https://api.test/a'),
      oauth.yandexFetchJson('YWM_OAUTH_TOKEN', 'https://api.test/b'),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(exchanges).toBe(1); // без дедупликации было бы 2 (и второй словил бы invalid_grant)
  });
});
