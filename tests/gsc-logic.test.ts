import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ENV_FILE и снапшот process.env вычисляются при импорте shared/config.js —
// поэтому env выставляется ДО динамического импорта модулей (образец — tests/xmlriver-serp.test.ts).
// Временный env-файл делает тест герметичным: реальный ~/.config/seo-tools-mcp/.env не читается.
// shared импортируем ТЕМ ЖЕ путём, что и сервер (через symlink в node_modules сервера → dist):
// иначе instanceof HttpError в isInvalidGrant сравнивал бы разные копии класса (src vs dist).
let logic: typeof import('../servers/gsc/src/logic.js');
let sharedDist: typeof import('../shared/src/index.js');
let dir: string;
let envFile: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-gsc-'));
  envFile = join(dir, '.env');
  process.env.SEO_TOOLS_MCP_ENV = envFile;
  writeFileSync(envFile, '', { mode: 0o600 });
  sharedDist = await import('../servers/gsc/node_modules/@seo-tools/shared');
  logic = await import('../servers/gsc/src/logic.js');
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

/** Перезаписывает временный env-файл и сбрасывает mtime-кеш shared. */
function setEnvFile(text: string): void {
  writeFileSync(envFile, text, { mode: 0o600 });
  sharedDist.readConfigFile(true);
}

describe('resolveSite', () => {
  it('явный siteUrl выигрывает у конфига', () => {
    setEnvFile('GSC_SITE_URL=sc-domain:from-config.com\n');
    expect(logic.resolveSite('https://explicit.com/')).toBe('https://explicit.com/');
  });

  it('без аргумента берёт GSC_SITE_URL из конфига', () => {
    setEnvFile('GSC_SITE_URL=sc-domain:from-config.com\n');
    expect(logic.resolveSite()).toBe('sc-domain:from-config.com');
  });

  it('без siteUrl и без дефолта → ошибка с адресацией (без account)', () => {
    setEnvFile('');
    expect(() => logic.resolveSite()).toThrow(/gsc_set_credentials \(GSC_SITE_URL\)/);
    expect(() => logic.resolveSite()).toThrow(/gsc_list_sites/);
  });

  it('account без настроенного дефолта → ошибка с именем профиля', () => {
    setEnvFile('GSC_SITE_URL=sc-domain:from-config.com\n'); // базовый дефолт есть, у профиля — нет
    expect(() => logic.resolveSite(undefined, 'ghost')).toThrow(/для аккаунта «ghost»/);
    expect(() => logic.resolveSite(undefined, 'ghost')).toThrow(/account="ghost"/);
  });

  it('дефолт профиля читается с суффиксом __account', () => {
    setEnvFile('GSC_SITE_URL=sc-domain:base.com\nGSC_SITE_URL__client1=sc-domain:client1.com\n');
    expect(logic.resolveSite(undefined, 'client1')).toBe('sc-domain:client1.com');
  });
});

describe('validateDates', () => {
  it('startDate > endDate → понятная ошибка с обеими датами', () => {
    expect(() => logic.validateDates('2025-06-01', '2025-05-01')).toThrow(/startDate \(2025-06-01\) позже endDate \(2025-05-01\)/);
  });

  it('startDate <= endDate (включая равенство) → ок', () => {
    expect(() => logic.validateDates('2025-05-01', '2025-06-01')).not.toThrow();
    expect(() => logic.validateDates('2025-05-01', '2025-05-01')).not.toThrow();
  });
});

describe('saJsonFileName (path traversal)', () => {
  it('без account → gsc-sa.json', () => {
    expect(logic.saJsonFileName()).toBe('gsc-sa.json');
  });

  it('валидный account → gsc-sa__<account>.json', () => {
    expect(logic.saJsonFileName('client1')).toBe('gsc-sa__client1.json');
  });

  it('account="../../tmp/x" → ошибка валидации, имя файла не строится', () => {
    expect(() => logic.saJsonFileName('../../tmp/x')).toThrow(/Недопустимое имя аккаунта/);
    expect(() => logic.saJsonFileName('../x')).toThrow(/Недопустимое имя аккаунта/);
    expect(() => logic.saJsonFileName('a/b')).toThrow(/Недопустимое имя аккаунта/);
  });
});

describe('isInvalidGrant', () => {
  it('HttpError с invalid_grant в теле → true', () => {
    const err = new sharedDist.HttpError(400, 'https://oauth2.googleapis.com/token', '{"error":"invalid_grant"}');
    expect(logic.isInvalidGrant(err)).toBe(true);
  });

  it('HttpError без invalid_grant и прочие ошибки → false', () => {
    expect(logic.isInvalidGrant(new sharedDist.HttpError(500, 'https://oauth2.googleapis.com/token', 'server error'))).toBe(false);
    expect(logic.isInvalidGrant(new Error('invalid_grant'))).toBe(false); // классификация только по HttpError
    expect(logic.isInvalidGrant('invalid_grant')).toBe(false);
  });
});

describe('forbidden403Hint', () => {
  it('содержит свойство, адресацию на list_sites/get_site и оба формата siteUrl', () => {
    const hint = logic.forbidden403Hint('sc-domain:example.com');
    expect(hint).toContain('sc-domain:example.com');
    expect(hint).toContain('gsc_list_sites');
    expect(hint).toContain('gsc_get_site');
    expect(hint).toContain('sc-domain:');
    expect(hint).toContain('завершающим');
  });
});

describe('mapKeysToDimensions', () => {
  const row = { keys: ['купить слона', 'mobile'], clicks: 5, impressions: 100, ctr: 0.05, position: 3.2 };

  it('keys разворачиваются в именованные dimensions', () => {
    expect(logic.mapKeysToDimensions(row, ['query', 'device'])).toEqual({
      query: 'купить слона',
      device: 'mobile',
      clicks: 5,
      impressions: 100,
      ctr: 0.05,
      position: 3.2,
    });
  });

  it('ключей больше, чем dimensions → хвост в key<N>', () => {
    const out = logic.mapKeysToDimensions(row, ['query']);
    expect(out.query).toBe('купить слона');
    expect(out.key1).toBe('mobile');
  });

  it('строка без keys → только метрики', () => {
    const out = logic.mapKeysToDimensions({ clicks: 1, impressions: 2, ctr: 0.5, position: 1 }, ['query']);
    expect(out).toEqual({ clicks: 1, impressions: 2, ctr: 0.5, position: 1 });
  });
});

describe('saKeyErrorText', () => {
  it('содержит путь, исходную ошибку и адресацию на починку', () => {
    const text = logic.saKeyErrorText('/cfg/gsc-sa.json', new Error('ENOENT: no such file'));
    expect(text).toContain('/cfg/gsc-sa.json');
    expect(text).toContain('ENOENT');
    expect(text).toContain('gsc_auth_status');
    expect(text).toContain('gsc_save_sa_json');
  });
});
