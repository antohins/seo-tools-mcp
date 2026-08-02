import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ENV_FILE вычисляется при импорте config.js из SEO_TOOLS_MCP_ENV —
// поэтому env выставляется ДО динамического импорта модуля.
let dir: string;
let config: typeof import('../shared/src/config.js');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-cfg-'));
  process.env.SEO_TOOLS_MCP_ENV = join(dir, '.env');
  config = await import('../shared/src/config.js');
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

describe('saveEnvValues: санитаризация значений', () => {
  it('значение с переводом строки отклоняется, файл не меняется', () => {
    config.saveEnvValues({ GOOD_KEY: '1' });
    const before = readFileSync(config.ENV_FILE, 'utf8');
    expect(() => config.saveEnvValues({ EVIL: 'x\nINJECTED=1' })).toThrow(/перевод строки/);
    expect(() => config.saveEnvValues({ EVIL: 'x\r\nINJECTED=1' })).toThrow(/перевод строки/);
    expect(readFileSync(config.ENV_FILE, 'utf8')).toBe(before);
    expect(readFileSync(config.ENV_FILE, 'utf8')).not.toContain('INJECTED');
  });
});

describe('saveEnvValues: протухший lock-каталог', () => {
  it('lock старше 30 с снимается, запись проходит, лок освобождается', () => {
    const lockDir = `${config.ENV_FILE}.lock`;
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 60_000); // «процесс умер минуту назад, не сняв лок»
    utimesSync(lockDir, old, old);

    config.saveEnvValues({ STALE_OK: '1' });
    expect(config.getConfig('STALE_OK')).toBe('1');
    expect(existsSync(lockDir)).toBe(false); // лок снят после записи
  });
});

describe('maskSecretsInText', () => {
  it('маскирует «ключ=значение» пары в произвольном тексте', () => {
    expect(config.maskSecretsInText('error at /?user=XXX&key=YYY&q=ok')).toBe('error at /?user=REDACTED&key=REDACTED&q=ok');
    expect(config.maskSecretsInText('client_secret=CS failed')).toBe('client_secret=REDACTED failed');
  });

  it('маскирует JSON-форму "ключ":"значение" (с пробелом и без), прочие поля не трогает', () => {
    expect(config.maskSecretsInText('{"password":"secret"}')).toBe('{"password":"REDACTED"}');
    expect(config.maskSecretsInText('{"token": "abc123", "q": "ok"}')).toBe('{"token": "REDACTED", "q": "ok"}');
  });
});
