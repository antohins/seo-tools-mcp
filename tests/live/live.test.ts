/**
 * Лайв-смоук: реально поднимает каждый сервер и дёргает БЕСПЛАТНЫЙ инструмент —
 * проверяет авторизацию + разбор ответа end-to-end. Нужны креды в ~/.config/seo-tools-mcp/.env.
 * Opt-in: запускать `pnpm test:live` (иначе набор пропускается). В CI не гоняется.
 * xmlstock_serp намеренно НЕ дёргаем — он платный; проверяем free-эндпоинт balance.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';

const LIVE = process.env.LIVE === '1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function callTool(server: string, name: string, args: Record<string, unknown> = {}) {
  const entry = join(ROOT, 'servers', server, 'dist', 'index.js');
  if (!existsSync(entry)) throw new Error(`Нет сборки ${entry} — сначала pnpm build`);
  const client = new Client({ name: 'live-smoke', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: 'node', args: [entry] });
  await client.connect(transport);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
    return { isError: !!res.isError, text };
  } finally {
    await client.close();
  }
}

describe.skipIf(!LIVE)('live smoke (LIVE=1, нужны креды)', () => {
  beforeAll(() => {
    if (!existsSync(join(ROOT, 'servers', 'gsc', 'dist', 'index.js'))) {
      throw new Error('Серверы не собраны — выполни `pnpm build` перед `pnpm test:live`');
    }
  });

  it('xmlstock_balance (free) — авторизация + баланс', { timeout: 30_000 }, async () => {
    const r = await callTool('xmlstock', 'xmlstock_balance');
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/balance/i);
  });

  it('wordstat_frequency (free quota)', { timeout: 30_000 }, async () => {
    const r = await callTool('wordstat', 'wordstat_frequency', { query: 'кофе' });
    expect(r.isError, r.text).toBe(false);
  });

  it('gsc_list_sites (free)', { timeout: 30_000 }, async () => {
    const r = await callTool('gsc', 'gsc_list_sites');
    expect(r.isError, r.text).toBe(false);
  });

  it('ywm_hosts (free)', { timeout: 30_000 }, async () => {
    const r = await callTool('ywm', 'ywm_hosts');
    expect(r.isError, r.text).toBe(false);
  });

  it('metrika_counters (free)', { timeout: 30_000 }, async () => {
    const r = await callTool('metrika', 'metrika_counters');
    expect(r.isError, r.text).toBe(false);
  });
});
