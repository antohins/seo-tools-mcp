import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Общая Google-авторизация (@seo-tools/shared/google), переиспользуемая gsc и ga4.
// shared импортируем ТЕМ ЖЕ путём, что и сервер (через symlink в node_modules сервера → dist):
// иначе instanceof HttpError в isInvalidGrant сравнивал бы разные копии класса (src vs dist).
let google: typeof import('../shared/src/google/index.js');
let sharedDist: typeof import('../shared/src/index.js');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-google-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  writeFileSync(process.env.SEO_TOOLS_MCP_ENV, '', { mode: 0o600 });
  sharedDist = await import('../servers/gsc/node_modules/@seo-tools/shared');
  // subpath ./google — прямым путём в dist: импорт по имени пакета из файлового пути не проходит через exports
  google = await import('../servers/gsc/node_modules/@seo-tools/shared/dist/google/index.js');
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

describe('isInvalidGrant', () => {
  it('HttpError с invalid_grant в теле → true', () => {
    const err = new sharedDist.HttpError(400, 'https://oauth2.googleapis.com/token', '{"error":"invalid_grant"}');
    expect(google.isInvalidGrant(err)).toBe(true);
  });

  it('HttpError без invalid_grant и прочие ошибки → false', () => {
    expect(google.isInvalidGrant(new sharedDist.HttpError(500, 'https://oauth2.googleapis.com/token', 'server error'))).toBe(false);
    expect(google.isInvalidGrant(new Error('invalid_grant'))).toBe(false); // классификация только по HttpError
    expect(google.isInvalidGrant('invalid_grant')).toBe(false);
  });
});

describe('saJsonFileName (path traversal)', () => {
  it('без account → <prefix>-sa.json', () => {
    expect(google.saJsonFileName('gsc')).toBe('gsc-sa.json');
    expect(google.saJsonFileName('ga4')).toBe('ga4-sa.json');
  });

  it('валидный account → <prefix>-sa__<account>.json', () => {
    expect(google.saJsonFileName('gsc', 'client1')).toBe('gsc-sa__client1.json');
    expect(google.saJsonFileName('ga4', 'client1')).toBe('ga4-sa__client1.json');
  });

  it('account="../../tmp/x" → ошибка валидации, имя файла не строится', () => {
    expect(() => google.saJsonFileName('gsc', '../../tmp/x')).toThrow(/Недопустимое имя аккаунта/);
    expect(() => google.saJsonFileName('ga4', '../x')).toThrow(/Недопустимое имя аккаунта/);
    expect(() => google.saJsonFileName('gsc', 'a/b')).toThrow(/Недопустимое имя аккаунта/);
  });
});

describe('createGoogleAuth: доменные тексты', () => {
  // фабрика вызывается ЛЕНИВО: тело describe исполняется до beforeAll, где импортируется модуль
  const mkAuth = () =>
    google.createGoogleAuth({
      toolPrefix: 'ga4',
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      refreshEnv: 'GA4_REFRESH_TOKEN',
      saJsonEnv: 'GA4_SA_JSON',
      apiName: 'Google Analytics Data API',
      noAuthHint: (account) => `Нет авторизации GA4${account ? ` для «${account}»` : ''}`,
      forbiddenHint: (ctx) => `403: нет доступа${ctx ? ` к ${ctx}` : ''}`,
    });

  it('saKeyErrorText содержит путь, исходную ошибку и адресацию на починку (префикс сервера)', () => {
    const text = mkAuth().saKeyErrorText('/cfg/ga4-sa.json', new Error('ENOENT: no such file'));
    expect(text).toContain('/cfg/ga4-sa.json');
    expect(text).toContain('ENOENT');
    expect(text).toContain('GA4_SA_JSON');
    expect(text).toContain('ga4_auth_status');
    expect(text).toContain('ga4_save_sa_json');
  });

  it('clientCreds без GOOGLE_CLIENT_* → ошибка адресует на <prefix>_oauth_start', () => {
    expect(() => mkAuth().clientCreds()).toThrow(/ga4_oauth_start/);
  });

  it('нет ни refresh-токена, ни SA → доменная подсказка сервера', async () => {
    await expect(mkAuth().getAccessToken()).rejects.toThrow(/Нет авторизации GA4/);
    await expect(mkAuth().getAccessToken('clientX')).rejects.toThrow(/для «clientX»/);
  });
});
