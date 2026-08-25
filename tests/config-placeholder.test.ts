/**
 * Хосты вроде маркетплейса плагинов Claude Code передают ключи через плейсхолдеры
 * (`${user_config.X}`). Если хост их не подставил — поле не заполнено или версия старая —
 * до сервера доезжает САМА СТРОКА шаблона. Она непустая, поэтому без защиты прошла бы за
 * настоящий ключ: auth_status отрапортовал бы ready, а провайдер ответил бы невнятной
 * ошибкой авторизации далеко от причины.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const dirs: string[] = [];

/** Свежий импорт config.js: initialEnv снимается на импорте, поэтому env ставим до него. */
async function withEnv(fileContent: string, env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'seo-tools-placeholder-'));
  dirs.push(dir);
  const file = join(dir, '.env');
  writeFileSync(file, fileContent, { mode: 0o600 });
  process.env.SEO_TOOLS_MCP_ENV = file;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  vi.resetModules();
  return await import('../shared/src/config.js');
}

afterEach(() => {
  for (const key of ['SEO_TOOLS_MCP_ENV', 'XMLSTOCK_KEY', 'XMLSTOCK_USER', 'GSC_REFRESH_TOKEN__client1']) delete process.env[key];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('неподставленный плейсхолдер не считается значением', () => {
  it('шаблон в окружении не перекрывает настоящий ключ из файла', async () => {
    const config = await withEnv('XMLSTOCK_KEY=настоящий-ключ\n', { XMLSTOCK_KEY: '${user_config.XMLSTOCK_KEY}' });
    expect(config.getConfig('XMLSTOCK_KEY')).toBe('настоящий-ключ');
    expect(config.hasRealEnvOverride('XMLSTOCK_KEY')).toBe(false);
  });

  it('без файла шаблон не выдаётся за значение', async () => {
    const config = await withEnv('', { XMLSTOCK_USER: '${user_config.XMLSTOCK_USER}' });
    expect(config.getConfig('XMLSTOCK_USER')).toBeUndefined();
  });

  it('шаблонный профиль не попадает в список аккаунтов', async () => {
    // иначе auth_status покажет несуществующий профиль как настроенный
    const config = await withEnv('', { GSC_REFRESH_TOKEN__client1: '${user_config.GSC_REFRESH_TOKEN}' });
    expect(config.accountsFor('GSC_REFRESH_TOKEN')).toEqual([]);
  });

  it('обычное значение со скобками внутри не страдает', async () => {
    const config = await withEnv('', { XMLSTOCK_KEY: 'abc${def}ghi' });
    expect(config.getConfig('XMLSTOCK_KEY')).toBe('abc${def}ghi');
  });
});
