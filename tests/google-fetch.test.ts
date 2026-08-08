import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Классификация ответов Google API в общем googleFetch (@seo-tools/shared/google):
// 403 → доменная подсказка, 429 → квота, 401 → один повтор со свежим токеном.
// shared берём из dist ТЕМ ЖЕ путём, что и сервер: иначе instanceof HttpError сравнивал бы разные копии класса.
let google: typeof import('../shared/src/google/index.js');
let dir: string;

const cfg = () => ({
  toolPrefix: 'ga4',
  scope: 'https://www.googleapis.com/auth/analytics.readonly',
  refreshEnv: 'GA4_REFRESH_TOKEN',
  saJsonEnv: 'GA4_SA_JSON',
  apiName: 'Google Analytics API (Data + Admin)',
  noAuthHint: () => 'нет авторизации',
  forbiddenHint: (ctx?: string) => `нет доступа${ctx ? ` к ${ctx}` : ''}`,
  quotaHint: 'корзины Core/Realtime считаются на свойство',
});

function res(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-gfetch-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  // refresh-токен есть → путь OAuth; обмен refresh→access мокается вместе с остальными fetch
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, 'GOOGLE_CLIENT_ID=cid\nGOOGLE_CLIENT_SECRET=sec\nGA4_REFRESH_TOKEN=rt\n', { mode: 0o600 });
  google = await import('../servers/ga4/node_modules/@seo-tools/shared/dist/google/index.js');
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Мок по URL, а не по порядку вызовов: обмен refresh→access может случиться несколько раз
 * (после 401 кеш токена сбрасывается и повтор запрашивает токен заново), поэтому очередь
 * ответов расходуется только на вызовы к самому API.
 */
const withToken = (...apiResponses: Response[]) => {
  const queue = [...apiResponses];
  const fetch = vi.fn(async (url: string) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return res(200, JSON.stringify({ access_token: 'tok', expires_in: 3600 }));
    }
    return queue.shift() ?? res(200, '{}');
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
};

describe('googleFetch: классификация ответов API', () => {
  it('403 → доменная подсказка с контекстом', async () => {
    withToken(res(403, '{"error":{"status":"PERMISSION_DENIED"}}'));
    const auth = google.createGoogleAuth(cfg());
    await expect(auth.googleFetch('https://analyticsdata.googleapis.com/x', {}, undefined, 'properties/123')).rejects.toThrow(
      /нет доступа к properties\/123/,
    );
  });

  it('429 → сообщение про квоту с доменной подсказкой, а не сырой RESOURCE_EXHAUSTED', async () => {
    // attempts:1 — иначе fetchJson сам ретраит 429 и съест мок
    withToken(res(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}'));
    const auth = google.createGoogleAuth(cfg());
    const p = auth.googleFetch('https://analyticsdata.googleapis.com/x', { attempts: 1 }, undefined, 'properties/123');
    await expect(p).rejects.toThrow(/исчерпана квота запросов \(429/);
    await expect(p).rejects.toThrow(/Core\/Realtime/);
  });

  it('429 из ПОВТОРА после 401 тоже классифицируется (не улетает сырым)', async () => {
    withToken(res(401, 'expired'), res(429, '{"error":{"status":"RESOURCE_EXHAUSTED"}}'));
    const auth = google.createGoogleAuth(cfg());
    await expect(auth.googleFetch('https://analyticsdata.googleapis.com/x', { attempts: 1 }, undefined, 'properties/1')).rejects.toThrow(
      /исчерпана квота запросов/,
    );
  });

  it('429 от token-эндпоинта НЕ выдаётся за квоту целевого API', async () => {
    // сам обмен refresh→access упирается в рейт-лимит: подсказка про limit/измерения тут вредна
    const fetch = vi.fn().mockResolvedValue(res(429, 'rate limited'));
    vi.stubGlobal('fetch', fetch);
    const auth = google.createGoogleAuth(cfg());
    await expect(auth.googleFetch('https://analyticsdata.googleapis.com/x', { attempts: 1 })).rejects.not.toThrow(/исчерпана квота/);
  });

  it('успех после 401: повтор со свежим токеном возвращает данные', async () => {
    withToken(res(401, 'expired'), res(200, JSON.stringify({ ok: 1 })));
    const auth = google.createGoogleAuth(cfg());
    await expect(auth.googleFetch<{ ok: number }>('https://analyticsdata.googleapis.com/x', { attempts: 1 })).resolves.toEqual({ ok: 1 });
  });
});
