import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ENV_FILE и снапшот process.env вычисляются при импорте shared/config.js —
// поэтому env выставляется ДО динамического импорта модуля (образец — tests/ywm.test.ts).
// Временный env-файл делает тест герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
let oauth: typeof import('../shared/src/yandex-oauth.js');
let dir: string;
let envFile: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-yoauth-'));
  envFile = join(dir, '.env');
  process.env.SEO_TOOLS_MCP_ENV = envFile;
  // защита от реального окружения процесса (initialEnv имеет приоритет над файлом)
  for (const k of ['YANDEX_OAUTH_TOKEN', 'YWM_OAUTH_TOKEN', 'YANDEX_REFRESH_TOKEN', 'YANDEX_CLIENT_ID', 'YANDEX_CLIENT_SECRET']) {
    delete process.env[k];
  }
  oauth = await import('../shared/src/yandex-oauth.js');
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
  vi.spyOn(console, 'error').mockImplementation(() => {}); // глушим stderr-логи oauth-слоя
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const writeEnv = (text: string) => writeFileSync(envFile, text, { mode: 0o600 });

describe('refresh: синхронизация specific === general (баг «инверсии usedSpecificForeign»)', () => {
  it('specific совпадает с общим → refresh переписывает ОБА ключа, следующий цикл не падает', async () => {
    writeEnv('YWM_OAUTH_TOKEN=tok1\nYANDEX_OAUTH_TOKEN=tok1\nYANDEX_REFRESH_TOKEN=rt1\nYANDEX_CLIENT_ID=cid\nYANDEX_CLIENT_SECRET=csec\n');

    // ДВА полных цикла «401 → refresh → повтор»: раньше после первого refresh
    // перезаписывался только общий ключ, и второй цикл падал с «отдельный токен,
    // авто-refresh не выполняется» (specific tok1 ≠ general tok2).
    let exchanges = 0;
    const expired = new Set(['tok1']); // «протухшие» токены: API отвечает на них 401
    const fetch = vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.includes('oauth.yandex.ru')) {
        exchanges += 1;
        return fakeRes({ access_token: `tok${exchanges + 1}`, refresh_token: `rt${exchanges + 1}`, expires_in: 3600 });
      }
      const token = String(init?.headers?.Authorization ?? '').replace(/^OAuth /, '');
      return expired.has(token) ? fakeRes('Unauthorized', 401) : fakeRes({ ok: 1 });
    });
    vi.stubGlobal('fetch', fetch);

    const first = await oauth.yandexFetchJson('YWM_OAUTH_TOKEN', 'https://api.test/x', {}, undefined, 'ywm');
    expect(first).toEqual({ ok: 1 });

    const envAfter = readFileSync(envFile, 'utf8');
    expect(envAfter).toContain('YANDEX_OAUTH_TOKEN=tok2');
    expect(envAfter).toContain('YWM_OAUTH_TOKEN=tok2'); // specific синхронизирован, а не застрял на tok1
    expect(envAfter).toContain('YANDEX_REFRESH_TOKEN=rt2');

    // второй цикл: tok2 «протух» — specific === general снова, refresh работает, «чужой токен» не диагностируется
    expired.add('tok2');
    const second = await oauth.yandexFetchJson('YWM_OAUTH_TOKEN', 'https://api.test/x', {}, undefined, 'ywm');
    expect(second).toEqual({ ok: 1 });
    const envFinal = readFileSync(envFile, 'utf8');
    expect(envFinal).toContain('YANDEX_OAUTH_TOKEN=tok3');
    expect(envFinal).toContain('YWM_OAUTH_TOKEN=tok3');
    expect(exchanges).toBe(2);
  });

  it('specific ≠ general (чужой токен) → refresh НЕ выполняется, понятная ошибка', async () => {
    writeEnv(
      'YWM_OAUTH_TOKEN=foreign\nYANDEX_OAUTH_TOKEN=tok1\nYANDEX_REFRESH_TOKEN=rt1\nYANDEX_CLIENT_ID=cid\nYANDEX_CLIENT_SECRET=csec\n',
    );
    const fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('oauth.yandex.ru')) return fakeRes({ access_token: 'tok2' });
      return fakeRes('Unauthorized', 401);
    });
    vi.stubGlobal('fetch', fetch);
    await expect(oauth.yandexFetchJson('YWM_OAUTH_TOKEN', 'https://api.test/x', {}, undefined, 'ywm')).rejects.toThrow(
      /Токен YWM_OAUTH_TOKEN протух.*отдельного токена/s,
    );
    // обмен refresh→access даже не вызывался: чужой токен не подменяем
    expect(fetch.mock.calls.filter(([u]) => String(u).includes('oauth.yandex.ru'))).toHaveLength(0);
  });
});

describe('refresh: различение «грант мёртв» и «refresh-токена нет»', () => {
  it('refresh-токен БЫЛ, но отклонён (invalid_grant) → «грант отозван или протух», а не «refresh-токена нет»', async () => {
    writeEnv('YANDEX_OAUTH_TOKEN=tok1\nYANDEX_REFRESH_TOKEN=rt1\nYANDEX_CLIENT_ID=cid\nYANDEX_CLIENT_SECRET=csec\n');
    const fetch = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.includes('oauth.yandex.ru')) return fakeRes('{"error":"invalid_grant"}', 400);
      return fakeRes('Unauthorized', 401);
    });
    vi.stubGlobal('fetch', fetch);
    const err = await oauth.yandexFetchJson('YWM_OAUTH_TOKEN', 'https://api.test/x', {}, undefined, 'ywm').catch((e) => e);
    expect(String(err)).toMatch(/отозван или протух/);
    expect(String(err)).toMatch(/ywm_oauth_start/);
    expect(String(err)).not.toMatch(/refresh-токена\/клиента для обновления нет/);
  });

  it('refresh-токена нет вовсе → прежнее сообщение «refresh-токена/клиента для обновления нет»', async () => {
    writeEnv('YANDEX_OAUTH_TOKEN=tok1\nYANDEX_CLIENT_ID=cid\nYANDEX_CLIENT_SECRET=csec\n');
    const fetch = vi.fn(async () => fakeRes('Unauthorized', 401));
    vi.stubGlobal('fetch', fetch);
    await expect(oauth.yandexFetchJson('YWM_OAUTH_TOKEN', 'https://api.test/x', {}, undefined, 'ywm')).rejects.toThrow(
      /refresh-токена\/клиента для обновления нет/,
    );
  });
});
