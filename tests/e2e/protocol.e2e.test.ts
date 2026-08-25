/**
 * Протокольный e2e: каждый СОБРАННЫЙ сервер поднимается как отдельный stdio-процесс,
 * с ним говорит настоящий MCP-клиент. Проверяется ровно то, чего не видят юнит-тесты:
 * сборка стартует, рукопожатие проходит, набор инструментов не поехал, аннотации честны.
 *
 * Сети не требует: `<prefix>_auth_status` целиком локальный. Конфиг подменяется на
 * пустой временный файл — тест НЕ должен видеть реальные ключи из ~/.config и тем
 * более случайно сходить в платный API.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SERVERS = ['xmlstock', 'xmlriver', 'wordstat', 'gsc', 'ga4', 'ywm', 'metrika', 'aparser'] as const;

/** Инструменты, которые ПИШУТ (в конфиг): единственные, кому позволено не быть read-only. */
const WRITERS = new Set([
  'xmlstock_set_credentials',
  'xmlriver_set_credentials',
  'wordstat_set_credentials',
  'aparser_set_credentials',
  'gsc_set_credentials',
  'gsc_oauth_start',
  'gsc_oauth_finish',
  'gsc_save_sa_json',
  'ga4_set_credentials',
  'ga4_oauth_start',
  'ga4_oauth_finish',
  'ga4_save_sa_json',
  'ywm_set_credentials',
  'ywm_oauth_start',
  'ywm_oauth_finish',
  'metrika_set_credentials',
  'metrika_oauth_start',
  'metrika_oauth_finish',
]);

// пустой конфиг во временном каталоге — реальные ключи пользователя не читаем
const EMPTY_ENV = join(mkdtempSync(join(tmpdir(), 'seo-tools-e2e-')), '.env');

interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
}

interface Session {
  tools: ToolInfo[];
  version?: string;
  name?: string;
  authStatus: { isError: boolean; text: string };
}

async function inspect(server: string): Promise<Session> {
  const entry = join(ROOT, 'servers', server, 'dist', 'index.js');
  const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    // окружение отдаём явно: иначе сервер подхватит настоящие ключи из шелла
    env: { PATH: process.env.PATH ?? '', SEO_TOOLS_MCP_ENV: EMPTY_ENV },
    stderr: 'ignore',
  });
  await client.connect(transport);
  try {
    const { tools } = (await client.listTools()) as { tools: ToolInfo[] };
    const info = client.getServerVersion();
    const res = (await client.callTool({ name: `${server}_auth_status`, arguments: {} })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    return {
      tools,
      version: info?.version,
      name: info?.name,
      authStatus: { isError: !!res.isError, text: res.content?.find((c) => c.type === 'text')?.text ?? '' },
    };
  } finally {
    await client.close();
  }
}

const sessions = new Map<string, Session>();
// корневой package.json — единственный источник истины по версии (см. scripts/sync-version.mjs)
const pkgVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;

beforeAll(async () => {
  const missing = SERVERS.filter((s) => !existsSync(join(ROOT, 'servers', s, 'dist', 'index.js')));
  if (missing.length) throw new Error(`Нет сборки: ${missing.join(', ')} — сначала \`pnpm build\``);
  writeFileSync(EMPTY_ENV, '');
  // последовательно: восемь параллельных node-процессов на слабой машине дают ложные таймауты
  for (const s of SERVERS) sessions.set(s, await inspect(s));
});

describe('MCP-протокол на собранных серверах', () => {
  it.each(SERVERS)('%s: рукопожатие проходит, сервер представляется собой', (server) => {
    const s = sessions.get(server) as Session;
    expect(s.name).toBe(server);
    expect(s.version).toBe(pkgVersion);
    expect(s.tools.length).toBeGreaterThan(0);
  });

  it.each(SERVERS)('%s: список инструментов не поехал', (server) => {
    // снапшот — чтобы удаление или переименование инструмента было видно в дифе ревью,
    // а не всплыло у пользователя как «этот инструмент пропал»
    expect((sessions.get(server) as Session).tools.map((t) => t.name).sort()).toMatchSnapshot();
  });

  it.each(SERVERS)('%s: у каждого инструмента есть title и описание', (server) => {
    for (const t of (sessions.get(server) as Session).tools) {
      expect(t.title, `${t.name}: пустой title`).toBeTruthy();
      expect(t.description, `${t.name}: пустое описание`).toBeTruthy();
    }
  });

  it.each(SERVERS)('%s: read-only заявлен ровно там, где он правда', (server) => {
    for (const t of (sessions.get(server) as Session).tools) {
      expect(`${t.name} readOnly=${t.annotations?.readOnlyHint}`).toBe(`${t.name} readOnly=${!WRITERS.has(t.name)}`);
      expect(`${t.name} openWorld=${t.annotations?.openWorldHint}`).toBe(`${t.name} openWorld=true`);
    }
  });

  it('во всём наборе ровно 18 пишущих инструментов', () => {
    // «только чтение» — главное обещание продукта; молчаливый рост этого числа его отменяет
    const writers = [...sessions.values()]
      .flatMap((s) => s.tools)
      .filter((t) => t.annotations?.readOnlyHint === false)
      .map((t) => t.name)
      .sort();
    expect(writers).toEqual([...WRITERS].sort());
  });

  it.each(SERVERS)('%s: auth_status работает без ключей и объясняет, чего не хватает', (server) => {
    const { isError, text } = (sessions.get(server) as Session).authStatus;
    expect(isError, text).toBe(false);
    const status = JSON.parse(text) as { ready: boolean; missing: string[]; help?: string };
    expect(status.ready).toBe(false); // конфиг пустой — сервер обязан это признать
    expect(status.missing.length).toBeGreaterThan(0);
  });
});
