#!/usr/bin/env node
/**
 * gsc-mcp — Google Search Console (Search Analytics) для SEO-пайплайна.
 * Авторизация (любой из двух путей):
 *  1) OAuth пользователя (gsc_oauth_start/finish) — токен видит ВСЕ свойства,
 *     доступные Google-аккаунту, добавлять пользователя в каждое свойство не нужно;
 *  2) service account (GSC_SA_JSON) — для headless-кронов; добавляется в каждое
 *     свойство вручную.
 * Питает: BASELINE 2.3, A.1 (морфо-кластеры), 2.5 (MAIN-KEYS).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { JWT } from 'google-auth-library';
import { writeFileSync, chmodSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadSharedEnv, requireEnv, envOr, envKey, getConfig, HttpError, fetchJson, jsonResult, safeHandler, registerAuthTools, accountParam, saveEnvValues, maskSecret, CONFIG_DIR } from '@seo-tools/shared';

loadSharedEnv();

const PAGE_SIZE = 25_000; // максимум GSC API за запрос
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const OAUTH_PORT = Number(process.env.GSC_OAUTH_PORT || 8585); // реальный env процесса — ок
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}`;

/** Свойство GSC: явный аргумент или GSC_SITE_URL (с суффиксом профиля) из конфига. */
function resolveSite(siteUrl?: string, account?: string): string {
  const site = siteUrl || getConfig('GSC_SITE_URL', account);
  if (!site) {
    throw new Error(
      `Не указано свойство GSC${account ? ` для аккаунта «${account}»` : ''}: передай siteUrl (например sc-domain:example.com) ` +
      'или сохрани дефолт через gsc_set_credentials' + (account ? ` (account="${account}")` : ' (GSC_SITE_URL)') + '. Список доступных — gsc_list_sites.',
    );
  }
  return site;
}

// кеши авторизации: ключ = имя аккаунта-профиля ('' = основной)
const jwtClients = new Map<string, { keyFile: string; client: JWT }>();
const cachedAccess = new Map<string, { token: string; exp: number }>();

function resetAuthCaches(): void {
  jwtClients.clear();
  cachedAccess.clear();
}

/** OAuth-клиент общий для всех профилей: суффикс → основной; понятная ошибка если нет. */
function googleClientCreds(account?: string): { clientId: string; clientSecret: string } {
  const clientId = envOr('GOOGLE_CLIENT_ID', account);
  const clientSecret = envOr('GOOGLE_CLIENT_SECRET', account);
  if (!clientId || !clientSecret) {
    throw new Error('Нет GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET — создай OAuth client (Desktop app) в console.cloud.google.com и передай в gsc_oauth_start.');
  }
  return { clientId, clientSecret };
}

async function getAccessToken(account?: string): Promise<string> {
  const cacheKey = account ?? '';
  // Путь 1: OAuth пользователя (приоритетный — видит все свойства аккаунта)
  const refreshToken = getConfig('GSC_REFRESH_TOKEN', account);
  if (refreshToken) {
    const hit = cachedAccess.get(cacheKey);
    if (hit && Date.now() < hit.exp - 60_000) return hit.token;
    const { clientId, clientSecret } = googleClientCreds(account);
    const data = await fetchJson<{ access_token: string; expires_in?: number }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    }).catch((err) => {
      if (err instanceof HttpError && err.bodySnippet.includes('invalid_grant')) {
        throw new Error('Google отверг refresh-токен (invalid_grant) — токен отозван или истёк (Testing-режим = 7 дней). Переавторизуйся: gsc_oauth_start → gsc_oauth_finish.');
      }
      throw err;
    });
    cachedAccess.set(cacheKey, { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 });
    return data.access_token;
  }

  // Путь 2: сервис-аккаунт
  const keyFile = getConfig('GSC_SA_JSON', account);
  if (!keyFile) {
    throw new Error(
      `Нет авторизации GSC${account ? ` для аккаунта «${account}»` : ''}. ` +
      `Либо OAuth: gsc_oauth_start${account ? ` (account="${account}")` : ''} → ссылка → gsc_oauth_finish (токен видит все свойства аккаунта), ` +
      'либо сервис-аккаунт: gsc_save_sa_json / gsc_set_credentials (GSC_SA_JSON) + добавить его email в каждое свойство.',
    );
  }
  const cached = jwtClients.get(cacheKey);
  let client = cached?.keyFile === keyFile ? cached.client : undefined;
  if (!client) {
    client = new JWT({ keyFile, scopes: [SCOPE] });
    jwtClients.set(cacheKey, { keyFile, client });
  }
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Не удалось получить access token по сервис-аккаунту (GSC_SA_JSON)');
  return token;
}

// ── Loopback-приёмник кода OAuth: ловит редирект Google на localhost ──
// Код привязан к конкретному flow (state + профиль) — чужой/устаревший код не подхватится.
interface OauthFlow {
  account: string | null;
  state: string;
  code: string | null;
}
let pendingFlow: OauthFlow | null = null;
let loopback: Server | null = null;

/** Поднимает приёмник; false — порт занят (EADDRINUSE приходит асинхронно, поэтому ждём listening/error). */
function startLoopback(): Promise<boolean> {
  if (loopback) return Promise.resolve(true);
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const matches = Boolean(code) && Boolean(pendingFlow) && state === pendingFlow!.state;
      if (matches) pendingFlow!.code = code;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(matches
        ? '<h2>Код получен ✓</h2><p>Вернись в чат и вызови gsc_oauth_finish (код подхватится автоматически).</p>'
        : '<h2>Код не принят</h2><p>Этот редирект не относится к текущей авторизации — повтори gsc_oauth_start и используй свежую ссылку.</p>');
    });
    srv.once('error', () => {
      loopback = null;
      resolve(false); // порт занят — сообщаем честно, oauth_start даст ручную инструкцию
    });
    srv.once('listening', () => {
      loopback = srv;
      setTimeout(() => stopLoopback(), 10 * 60_000).unref(); // авто-закрытие
      resolve(true);
    });
    srv.listen(OAUTH_PORT, '127.0.0.1');
  });
}

function stopLoopback(): void {
  loopback?.close();
  loopback = null;
}

/** fetch к Google API с авторизацией; при 401 сбрасывает кеш access-токена и повторяет один раз. */
async function gscFetch<T>(url: string, init: { method?: 'GET' | 'POST'; body?: string; attempts?: number }, account?: string): Promise<T> {
  const { attempts, ...rest } = init;
  const exec = async () => {
    const token = await getAccessToken(account);
    return fetchJson<T>(url, {
      ...rest,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeoutMs: 120_000, // ceiling для «жирных» страниц (25k строк не влезают в 60с); быстрым вызовам безвреден
      ...(attempts !== undefined ? { attempts } : {}), // ретраи ограничиваем только там, где нужно (пагинация)
    });
  };
  try {
    return await exec();
  } catch (err) {
    if (err instanceof HttpError && err.status === 401) {
      cachedAccess.delete(account ?? ''); // токен отозван раньше expires_in — берём свежий
      return exec();
    }
    throw err;
  }
}

interface GscRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

async function queryAll(siteUrl: string, body: Record<string, unknown>, limit: number, account?: string): Promise<{ rows: GscRow[]; truncated: boolean }> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const rows: GscRow[] = [];
  let startRow = 0;
  const probe = limit + 1; // тянем на 1 строку больше запрошенного — чтобы отличить «ровно limit» от «есть ещё»

  while (rows.length < probe) {
    const rowLimit = Math.min(PAGE_SIZE, probe - rows.length);
    const page = await gscFetch<{ rows?: GscRow[] }>(url, {
      method: 'POST',
      body: JSON.stringify({ ...body, rowLimit, startRow }),
      attempts: 2, // длинный таймаут × 3 ретрая × 401-повтор × страницы иначе висит минутами
    }, account);
    const batch = page.rows ?? [];
    rows.push(...batch);
    if (batch.length < rowLimit) break; // страница неполная — данных больше нет
    startRow += batch.length;
  }
  // получили лишнюю (limit+1)-ю строку → данные ещё остались; отдаём ровно limit
  const truncated = rows.length > limit;
  return { rows: rows.slice(0, limit), truncated };
}

const server = new McpServer({ name: 'gsc', version: '1.0.0' });

registerAuthTools(server, 'gsc', [
  { env: 'GOOGLE_CLIENT_ID', label: 'OAuth client ID из Google Cloud (для пути OAuth)', secret: false, required: false },
  { env: 'GOOGLE_CLIENT_SECRET', label: 'OAuth client secret из Google Cloud', required: false },
  { env: 'GSC_REFRESH_TOKEN', label: 'Refresh-токен OAuth (получается через gsc_oauth_start/finish)', required: false },
  { env: 'GSC_SA_JSON', label: 'Путь к JSON-ключу сервис-аккаунта (альтернативный путь)', secret: false, required: false },
  { env: 'GSC_SITE_URL', label: 'Свойство GSC по умолчанию (sc-domain:example.com)', secret: false, required: false },
], {
  help:
    'Два пути. РЕКОМЕНДУЕМЫЙ — OAuth (токен видит ВСЕ свойства твоего Google-аккаунта, ничего не надо добавлять по-сайтово): ' +
    '1) console.cloud.google.com → проект → включить Google Search Console API; ' +
    '2) APIs & Services → OAuth consent screen: External, добавить себя в Test users (или Publish app для долгоживущего токена); ' +
    '3) Credentials → Create credentials → OAuth client ID → тип Desktop app → взять client ID и secret; ' +
    '4) gsc_oauth_start → открыть ссылку → разрешить → gsc_oauth_finish. ' +
    'АЛЬТЕРНАТИВА — сервис-аккаунт (для кронов): IAM → Service Accounts → JSON-ключ → gsc_save_sa_json → добавить email аккаунта в каждое свойство GSC. ' +
    'Проверка — gsc_list_sites.',
  requireAnyOf: [['GSC_REFRESH_TOKEN', 'GSC_SA_JSON']],
  onSave: resetAuthCaches,
});

server.registerTool(
  'gsc_oauth_start',
  {
    description:
      'Шаг 1 OAuth-авторизации Google: вернёт ссылку — пользователь открывает её под аккаунтом, у которого есть доступ к нужным свойствам GSC, ' +
      'и разрешает read-only доступ. Токен будет видеть ВСЕ свойства аккаунта (добавлять пользователя в каждое свойство не нужно). ' +
      'Требуется OAuth client типа Desktop app (client ID + secret из console.cloud.google.com). ' +
      'После согласия Google отправит браузер на localhost — код подхватится автоматически, затем вызвать gsc_oauth_finish.',
    inputSchema: {
      clientId: z.string().optional().describe('OAuth client ID (если не сохранён как GOOGLE_CLIENT_ID)'),
      clientSecret: z.string().optional().describe('OAuth client secret'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const values: Record<string, string> = {};
    if (args.clientId) values.GOOGLE_CLIENT_ID = args.clientId.trim();
    if (args.clientSecret) values.GOOGLE_CLIENT_SECRET = args.clientSecret.trim();
    if (Object.keys(values).length) saveEnvValues(values);
    const clientId = envOr('GOOGLE_CLIENT_ID', args.account);
    if (!clientId || !envOr('GOOGLE_CLIENT_SECRET', args.account)) {
      return jsonResult({
        ready: false,
        action:
          'Сначала создай OAuth client в console.cloud.google.com (APIs & Services → Credentials → OAuth client ID → Desktop app; ' +
          'перед этим включить Google Search Console API и настроить OAuth consent screen) и передай clientId + clientSecret в этот инструмент.',
      });
    }
    // новый flow: свежий state, прежний пойманный код (если был) сбрасывается
    pendingFlow = { account: args.account ?? null, state: randomUUID(), code: null };
    const listenerOk = await startLoopback();
    const qs = new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline', // нужен refresh-токен
      prompt: 'consent',
      state: pendingFlow.state, // привязка кода к этому flow/профилю
    });
    return jsonResult({
      ready: true,
      account: args.account ?? null,
      authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?${qs}`,
      next: (listenerOk
        ? 'Пользователь открывает ссылку' + (args.account ? ` под Google-аккаунтом профиля «${args.account}»` : '') + ', разрешает доступ — браузер редиректнется на localhost и код будет подхвачен. Затем вызвать gsc_oauth_finish' + (args.account ? ` с account="${args.account}"` : ' без аргументов') + '.'
        : `Порт ${OAUTH_PORT} занят (другой процесс?): после согласия скопировать параметр code из адресной строки (localhost:${OAUTH_PORT}/?code=...) и передать в gsc_oauth_finish. Либо задать другой порт через GSC_OAUTH_PORT.`),
    });
  }),
);

server.registerTool(
  'gsc_oauth_finish',
  {
    description:
      'Шаг 2 OAuth-авторизации Google: обменивает код на access+refresh токены и сохраняет их. ' +
      'Без аргументов берёт код, пойманный localhost-приёмником после gsc_oauth_start; можно передать код вручную.',
    inputSchema: {
      code: z.string().optional().describe('Код из редиректа (обычно не нужен — подхватывается автоматически)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const account = args.account ?? null;
    // защита от подмены профиля: пойманный код принадлежит flow конкретного account
    if (pendingFlow && account !== pendingFlow.account) {
      throw new Error(
        `Текущая авторизация запущена для профиля «${pendingFlow.account ?? 'основной'}», а finish вызван с «${account ?? 'основной'}». ` +
        'Заверши тот flow или повтори gsc_oauth_start с нужным account.',
      );
    }
    const code = args.code?.trim() || pendingFlow?.code;
    if (!code) {
      throw new Error('Код не получен: сначала gsc_oauth_start и авторизация в браузере (или передай code вручную).');
    }
    const { clientId, clientSecret } = googleClientCreds(args.account);
    const data = await fetchJson<{ access_token: string; refresh_token?: string; expires_in?: number }>(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: REDIRECT_URI,
        }).toString(),
      },
    );
    stopLoopback();
    pendingFlow = null;
    if (!data.refresh_token) {
      throw new Error('Google не вернул refresh_token (повтори gsc_oauth_start — там стоит prompt=consent — и согласись заново).');
    }
    saveEnvValues({ [envKey('GSC_REFRESH_TOKEN', args.account)]: data.refresh_token });
    resetAuthCaches();
    return jsonResult({
      ok: true,
      account,
      refreshToken: maskSecret(data.refresh_token),
      note: 'Токен видит все свойства аккаунта. Если OAuth-приложение в статусе Testing — refresh живёт 7 дней (Publish app в consent screen решает). Проверка — gsc_list_sites.',
    });
  }),
);

server.registerTool(
  'gsc_save_sa_json',
  {
    description:
      'Сохранить содержимое JSON-ключа сервис-аккаунта в конфиг-директорию (права 600) и прописать GSC_SA_JSON. ' +
      'Альтернатива, если файл уже лежит на диске: gsc_set_credentials с путём в GSC_SA_JSON.',
    inputSchema: {
      json: z.string().describe('Полное содержимое скачанного JSON-ключа сервис-аккаунта'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    let parsed: { client_email?: string; private_key?: string };
    try {
      parsed = JSON.parse(args.json);
    } catch {
      throw new Error('Невалидный JSON — передай содержимое файла ключа сервис-аккаунта целиком');
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('JSON не похож на ключ сервис-аккаунта (нет client_email/private_key)');
    }
    const file = join(CONFIG_DIR, args.account ? `gsc-sa__${args.account}.json` : 'gsc-sa.json');
    writeFileSync(file, args.json, { mode: 0o600 });
    chmodSync(file, 0o600);
    saveEnvValues({ [envKey('GSC_SA_JSON', args.account)]: file });
    resetAuthCaches();
    return jsonResult({ ok: true, savedTo: file, serviceAccountEmail: parsed.client_email,
      next: 'Добавь этот email в GSC → Настройки → Пользователи и права (права «Полный»), затем проверь gsc_list_sites.' });
  }),
);

server.registerTool(
  'gsc_query',
  {
    description:
      'Search Analytics по свойству GSC (по умолчанию GSC_SITE_URL из конфига). ' +
      'Возвращает строки {query|page|device..., clicks, impressions, ctr, position}. ' +
      'Пагинация собирается автоматически до rowLimit; ответ несёт truncated=true, если упёрлись в rowLimit (данные могли остаться). ' +
      'page — точный URL страницы для фильтра (опционально); dimensions — например ["query"], ["query","device"], ["page"].',
    inputSchema: {
      siteUrl: z.string().optional().describe('Свойство GSC, например sc-domain:example.com (по умолчанию GSC_SITE_URL из конфига)'),
      page: z.string().optional().describe('Точный URL страницы для фильтра, например https://example.com/page/'),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
      dimensions: z.array(z.enum(['query', 'page', 'device', 'country', 'date', 'searchAppearance']))
        .default(['query']),
      searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
      rowLimit: z.number().int().min(1).max(200_000).default(5000)
        .describe('Сколько строк собрать суммарно (пагинация автоматическая)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const siteUrl = resolveSite(args.siteUrl, args.account);
    const body: Record<string, unknown> = {
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: args.dimensions,
      type: args.searchType,
      dataState: 'final',
    };
    if (args.page) {
      body.dimensionFilterGroups = [
        { filters: [{ dimension: 'page', operator: 'equals', expression: args.page }] },
      ];
    }
    const { rows: raw, truncated } = await queryAll(siteUrl, body, args.rowLimit, args.account);
    const rows = raw.map((r) => {
      const out: Record<string, unknown> = {
        clicks: r.clicks,
        impressions: r.impressions,
        ctr: r.ctr,
        position: r.position,
      };
      (r.keys ?? []).forEach((key, i) => {
        out[args.dimensions[i] ?? `key${i}`] = key;
      });
      return out;
    });
    console.error(`[gsc] ${siteUrl} ${args.startDate}..${args.endDate} dims=${args.dimensions.join(',')} → ${rows.length} строк${truncated ? ' (обрезано по rowLimit)' : ''}`);
    return jsonResult({ siteUrl, startDate: args.startDate, endDate: args.endDate, dimensions: args.dimensions, rowCount: rows.length, truncated, rows });
  }),
);

server.registerTool(
  'gsc_list_sites',
  {
    description: 'Список свойств GSC, доступных авторизации (OAuth-аккаунту или сервис-аккаунту) — проверка доступа.',
    inputSchema: {
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const data = await gscFetch<{ siteEntry?: Array<{ siteUrl: string; permissionLevel: string }> }>(
      'https://www.googleapis.com/webmasters/v3/sites',
      {},
      args.account,
    );
    return jsonResult({ sites: data.siteEntry ?? [] });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[gsc] MCP-сервер запущен (stdio)');
