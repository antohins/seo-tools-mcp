import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => JSON.parse(readFileSync(join(ROOT, ...p), 'utf8'));

const marketplace = read('.claude-plugin', 'marketplace.json');
const pluginDirs = readdirSync(join(ROOT, 'plugins'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const servers = readdirSync(join(ROOT, 'servers'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

describe('маркетплейс плагинов Claude Code', () => {
  it('в каталоге перечислены ровно те плагины, что лежат в plugins/', () => {
    // иначе новый плагин существует на диске, но не ставится ни одной командой
    expect(marketplace.plugins.map((p: { name: string }) => p.name).sort()).toEqual(pluginDirs);
  });

  it('у каждого сервера есть свой плагин (плюс бандл seo-tools)', () => {
    expect(pluginDirs).toEqual([...servers, 'seo-tools'].sort());
  });

  it.each(pluginDirs)('%s: source ведёт в свой каталог, имена совпадают', (name) => {
    const entry = marketplace.plugins.find((p: { name: string }) => p.name === name);
    expect(entry.source).toBe(`./plugins/${name}`);
    expect(read('plugins', name, '.claude-plugin', 'plugin.json').name).toBe(name);
  });

  it.each(pluginDirs)('%s: mcpServers лежит в .mcp.json, а не инлайном в манифесте', (name) => {
    // при инлайн-форме `claude plugin details` показывает «MCP servers (0)»
    const manifest = read('plugins', name, '.claude-plugin', 'plugin.json');
    expect(manifest.mcpServers).toBeUndefined();
    expect(Object.keys(read('plugins', name, '.mcp.json').mcpServers).length).toBeGreaterThan(0);
  });

  it.each(pluginDirs)('%s: запускает опубликованные пакеты своих серверов', (name) => {
    const entries = Object.entries<{ command: string; args: string[] }>(read('plugins', name, '.mcp.json').mcpServers);
    // порядок в бандле осмысленный (SERP → частотки → аналитика), поэтому сверяем состав
    const expected = name === 'seo-tools' ? servers : [name];
    expect(entries.map(([id]) => id).sort()).toEqual(expected);
    for (const [id, cfg] of entries) {
      expect(cfg.command).toBe('npx');
      expect(cfg.args).toEqual(['-y', `seo-tools-mcp-${id}`]);
      expect(read('servers', id, 'package.json').name).toBe(`seo-tools-mcp-${id}`);
    }
  });

  it('каждый ключ userConfig проброшен в env своего сервера', () => {
    // иначе пользователь заполняет диалог, а сервер этих значений не видит
    for (const name of pluginDirs) {
      const keys = Object.keys(read('plugins', name, '.claude-plugin', 'plugin.json').userConfig ?? {});
      const env = read('plugins', name, '.mcp.json').mcpServers[name]?.env ?? {};
      expect({ [name]: Object.keys(env).sort() }).toEqual({ [name]: keys.sort() });
      for (const key of keys) expect(env[key]).toBe(`\${user_config.${key}}`);
    }
  });

  it('секретные поля помечены sensitive', () => {
    const secretish = /KEY|SECRET|PASSWORD|TOKEN/;
    for (const name of pluginDirs) {
      const cfg = read('plugins', name, '.claude-plugin', 'plugin.json').userConfig ?? {};
      for (const [key, spec] of Object.entries<{ sensitive?: boolean }>(cfg)) {
        if (secretish.test(key)) expect(`${name}.${key}=${spec.sensitive}`).toBe(`${name}.${key}=true`);
      }
    }
  });
});
