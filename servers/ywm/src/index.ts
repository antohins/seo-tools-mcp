#!/usr/bin/env node
/**
 * ywm-mcp — Яндекс.Вебмастер API v4 (read-only) для SEO-пайплайна.
 * Авторизация: OAuth-токен (YWM_OAUTH_TOKEN или общий YANDEX_OAUTH_TOKEN);
 * интерактивная авторизация — ywm_oauth_start/ywm_oauth_finish (code flow + авто-refresh).
 * Хост по умолчанию — YWM_HOST_ID из конфига (ywm_set_credentials), список — ywm_hosts.
 * Питает: BASELINE (Яндекс-сторона), A.5.
 *
 * Важно: фильтр по URL существует ТОЛЬКО в query-analytics/list (данные ~2 недели);
 * эндпоинта «рекомендованные запросы» в API v4 НЕТ — ywm_recommended_queries
 * аппроксимирует его через метрику DEMAND (спрос) + недобор кликов/позиций.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  accountParam,
  getConfig,
  jsonResult,
  loadSharedEnv,
  registerAuthTools,
  registerYandexOauthTools,
  safeHandler,
  yandexFetchJson,
} from '@seo-tools/shared';
import { z } from 'zod';

loadSharedEnv();

const BASE = 'https://api.webmaster.yandex.net/v4';
const TOKEN_ENV = 'YWM_OAUTH_TOKEN';

function ywmGet<T = any>(path: string, account?: string): Promise<T> {
  return yandexFetchJson<T>(TOKEN_ENV, `${BASE}${path}`, {}, account);
}

function ywmPost<T = any>(path: string, body: unknown, account?: string): Promise<T> {
  return yandexFetchJson<T>(
    TOKEN_ENV,
    `${BASE}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    account,
  );
}

// сколько строк максимум тянем для честной сортировки топа (6 API-страниц по 500)
const SORT_FETCH_CAP = 3000;

/** Хост: явный аргумент или YWM_HOST_ID (с суффиксом профиля) из конфига. */
function resolveHost(hostId?: string, account?: string): string {
  const host = hostId || getConfig('YWM_HOST_ID', account);
  if (!host) {
    throw new Error(
      `Не указан хост Вебмастера${account ? ` для аккаунта «${account}»` : ''}: передай hostId (формат https:example.com:443) ` +
        'или сохрани дефолт через ywm_set_credentials' +
        (account ? ` (account="${account}")` : ' (YWM_HOST_ID)') +
        '. Список хостов — ywm_hosts.',
    );
  }
  return host;
}

const cachedUsers = new Map<string, string>(); // account ?? '' → user_id (переживает refresh токена)
async function getUserId(account?: string): Promise<string> {
  const pinned = getConfig('YWM_USER_ID', account);
  if (pinned) return pinned;
  const cacheKey = account ?? '';
  const hit = cachedUsers.get(cacheKey);
  if (hit) return hit;
  const data = await ywmGet<{ user_id: number }>('/user/', account);
  cachedUsers.set(cacheKey, String(data.user_id));
  return String(data.user_id);
}

interface QaTextStat {
  text_indicator?: { type: string; value: string };
  statistics?: Array<{ date: string; field: string; value: number }>;
}

/**
 * POST query-analytics/list c пагинацией (limit API — 500 за страницу).
 * maxRows может быть функцией от count — чтобы после первой страницы решить,
 * сколько тянуть (например «всё до SORT_FETCH_CAP» для честной сортировки топа).
 */
async function queryAnalytics(
  hostId: string,
  body: Record<string, unknown>,
  maxRows: number | ((count: number) => number),
  account?: string,
): Promise<{ count: number; items: QaTextStat[] }> {
  const userId = await getUserId(account);
  const path = `/user/${userId}/hosts/${encodeURIComponent(hostId)}/query-analytics/list`;
  const items: QaTextStat[] = [];
  let offset = 0;
  let count = 0;
  let target = typeof maxRows === 'number' ? maxRows : 500; // до первой страницы count неизвестен

  while (items.length < target) {
    const limit = Math.min(500, target - items.length);
    const page = await ywmPost<{ count: number; text_indicator_to_statistics: QaTextStat[] }>(path, { ...body, offset, limit }, account);
    count = page.count ?? 0;
    if (typeof maxRows === 'function') target = maxRows(count);
    const batch = page.text_indicator_to_statistics ?? [];
    items.push(...batch);
    if (!batch.length || items.length >= count) break;
    offset += batch.length;
  }
  return { count, items };
}

/** Сворачивает дневные statistics в агрегаты по запросу. */
function aggregate(stats: NonNullable<QaTextStat['statistics']>) {
  let shows = 0;
  let clicks = 0;
  let demand = 0;
  const posValues: number[] = [];
  for (const s of stats) {
    switch (s.field) {
      case 'IMPRESSIONS':
        shows += s.value;
        break;
      case 'CLICKS':
        clicks += s.value;
        break;
      case 'DEMAND':
        demand += s.value;
        break;
      case 'POSITION':
        posValues.push(s.value);
        break;
    }
  }
  // позиция: простое среднее по дням (повзвесить на показы построчно API не даёт)
  const position = posValues.length ? posValues.reduce((a, b) => a + b, 0) / posValues.length : null;
  return {
    shows,
    clicks,
    ctr: shows > 0 ? clicks / shows : 0,
    position: position !== null ? Math.round(position * 10) / 10 : null,
    demand,
  };
}

const server = new McpServer({ name: 'ywm', version: '1.0.0' });

registerAuthTools(
  server,
  'ywm',
  [
    { env: 'YANDEX_OAUTH_TOKEN', label: 'Общий OAuth-токен Яндекса (Вебмастер+Метрика)', required: false },
    { env: 'YWM_OAUTH_TOKEN', label: 'Отдельный токен Вебмастера (перекрывает общий; обычно не нужен)', required: false },
    { env: 'YANDEX_CLIENT_ID', label: 'ClientID OAuth-приложения Яндекса (для авторизации/refresh)', secret: false, required: false },
    { env: 'YANDEX_CLIENT_SECRET', label: 'Client secret OAuth-приложения Яндекса', required: false },
    { env: 'YWM_HOST_ID', label: 'Хост по умолчанию (формат https:example.com:443)', secret: false, required: false },
    { env: 'YWM_USER_ID', label: 'user_id Вебмастера (определяется автоматически, можно не задавать)', secret: false, required: false },
  ],
  {
    help:
      'Нужен OAuth-токен со scope Вебмастера. Быстрый путь: ywm_oauth_start (регистрация приложения на ' +
      'oauth.yandex.ru/client/new: Веб-сервисы, Redirect URI https://oauth.yandex.ru/verification_code, ' +
      'права «Яндекс.Вебмастер»: hostinfo + verify; + «Яндекс.Метрика»: чтение — тогда один токен на оба сервера) → ' +
      'пользователь открывает ссылку → код → ywm_oauth_finish. Проверка — ywm_hosts. ' +
      'ВНИМАНИЕ: токен должен быть или YANDEX_OAUTH_TOKEN (общий), или YWM_OAUTH_TOKEN.',
    requireAnyOf: [['YANDEX_OAUTH_TOKEN', 'YWM_OAUTH_TOKEN']],
    onSave: () => {
      cachedUsers.clear();
    },
  },
);

registerYandexOauthTools(server, 'ywm', 'Яндекс.Вебмастер (hostinfo + verify), опционально + Метрика (чтение)', () => {
  cachedUsers.clear();
});

const deviceParam = z.enum(['ALL', 'DESKTOP', 'MOBILE_AND_TABLET', 'MOBILE', 'TABLET']).default('ALL');

const hostIdParam = z.string().optional().describe('Хост Вебмастера (формат https:example.com:443); по умолчанию YWM_HOST_ID');

/** Резолвит host + user_id и собирает префикс пути /user/{id}/hosts/{host}. */
async function hostCtx(hostId: string | undefined, account?: string): Promise<{ hostId: string; base: string }> {
  const h = resolveHost(hostId, account);
  const userId = await getUserId(account);
  return { hostId: h, base: `/user/${userId}/hosts/${encodeURIComponent(h)}` };
}

/** Диапазон дат YYYY-MM-DD: заданный или последние `days` дней. */
function dateRange(from: string | undefined, to: string | undefined, days: number): { date_from: string; date_to: string } {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { date_from: from ?? iso(Date.now() - days * 864e5), date_to: to ?? iso(Date.now()) };
}

const dateFromParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('YYYY-MM-DD (по умолчанию — от дефолтного окна)');
const dateToParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('YYYY-MM-DD (по умолчанию сегодня)');

server.registerTool(
  'ywm_hosts',
  {
    description: 'user_id токена и список сайтов в Вебмастере (host_id, verified) — для проверки доступа и настройки YWM_HOST_ID.',
    inputSchema: {
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const userId = await getUserId(args.account);
    const data = await ywmGet<{ hosts: Array<Record<string, unknown>> }>(`/user/${userId}/hosts`, args.account);
    return jsonResult({ account: args.account ?? null, user_id: userId, hosts: data.hosts ?? [] });
  }),
);

server.registerTool(
  'ywm_search_queries',
  {
    description:
      'Запросы Яндекса по конкретному URL (query-analytics, данные за ~2 недели): ' +
      '{ rows: [{ query, shows, clicks, ctr, position, demand }] }. ' +
      'url — путь («/oae/dubai/») или полный URL; сопоставление TEXT_CONTAINS по умолчанию. ' +
      'Без url — топ запросов всего хоста.',
    inputSchema: {
      url: z.string().optional().describe('Путь или URL страницы; пусто = весь хост'),
      urlMatch: z.enum(['TEXT_CONTAINS', 'TEXT_MATCH']).default('TEXT_CONTAINS'),
      device: deviceParam,
      orderBy: z
        .enum(['IMPRESSIONS', 'CLICKS', 'CTR', 'POSITION', 'DEMAND'])
        .default('IMPRESSIONS')
        .describe('Поле сортировки результата (после агрегации)'),
      limit: z.number().int().min(1).max(3000).default(500),
      hostId: z.string().optional().describe('Хост (по умолчанию YWM_HOST_ID из конфига)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const hostId = resolveHost(args.hostId, args.account);
    const body: Record<string, unknown> = {
      text_indicator: 'QUERY',
      device_type_indicator: args.device,
    };
    if (args.url) {
      body.filters = {
        text_filters: [{ text_indicator: 'URL', operation: args.urlMatch, value: args.url }],
      };
    }
    // для честного «топа по orderBy» тянем ВСЕ строки (до SORT_FETCH_CAP), сортируем, режем до limit
    const { count, items } = await queryAnalytics(
      hostId,
      body,
      (total) => Math.min(Math.max(args.limit, total), SORT_FETCH_CAP),
      args.account,
    );
    let rows = items.map((it) => ({
      query: it.text_indicator?.value ?? '',
      ...aggregate(it.statistics ?? []),
    }));
    const key = { IMPRESSIONS: 'shows', CLICKS: 'clicks', CTR: 'ctr', POSITION: 'position', DEMAND: 'demand' }[args.orderBy] as
      | 'shows'
      | 'clicks'
      | 'ctr'
      | 'position'
      | 'demand';
    rows = rows.sort((a, b) => {
      const av = a[key] ?? Number.POSITIVE_INFINITY;
      const bv = b[key] ?? Number.POSITIVE_INFINITY;
      return args.orderBy === 'POSITION' ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
    rows = rows.slice(0, args.limit);
    return jsonResult({
      hostId,
      url: args.url ?? null,
      totalQueries: count,
      rowCount: rows.length,
      ...(count > SORT_FETCH_CAP
        ? {
            approximate: true,
            note: `запросов ${count} > ${SORT_FETCH_CAP}: топ отсортирован по первым ${SORT_FETCH_CAP} строкам выборки API`,
          }
        : {}),
      rows,
    });
  }),
);

server.registerTool(
  'ywm_recommended_queries',
  {
    description:
      'Недобранные запросы по URL (аппроксимация: в API v4 нет «рекомендованных» — берём запросы ' +
      'со спросом (DEMAND), где кликов нет или позиция за топ-10): { queries: [{ query, demand, shows, position, reason }] }.',
    inputSchema: {
      url: z.string().describe('Путь («/oae/dubai/») или полный URL страницы'),
      device: deviceParam,
      limit: z.number().int().min(1).max(1000).default(200),
      hostId: z.string().optional().describe('Хост (по умолчанию YWM_HOST_ID из конфига)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const hostId = resolveHost(args.hostId, args.account);
    const { count, items } = await queryAnalytics(
      hostId,
      {
        text_indicator: 'QUERY',
        device_type_indicator: args.device,
        filters: { text_filters: [{ text_indicator: 'URL', operation: 'TEXT_CONTAINS', value: args.url }] },
      },
      (total) => Math.min(total, SORT_FETCH_CAP), // все строки до капа — фильтр/сортировка честные
      args.account,
    );
    const queries = items
      .map((it) => ({ query: it.text_indicator?.value ?? '', ...aggregate(it.statistics ?? []) }))
      .filter((r) => (r.shows > 0 && r.clicks === 0) || (r.position !== null && r.position > 10) || r.demand > 0)
      .map((r) => ({
        query: r.query,
        demand: r.demand,
        shows: r.shows,
        clicks: r.clicks,
        position: r.position,
        reason:
          r.clicks === 0 && r.shows > 0 ? 'показы без кликов' : r.position !== null && r.position > 10 ? 'позиция за топ-10' : 'есть спрос',
      }))
      .sort((a, b) => b.demand - a.demand || b.shows - a.shows)
      .slice(0, args.limit);
    return jsonResult({
      hostId,
      url: args.url,
      note: 'аппроксимация: API v4 не отдаёт «рекомендованные запросы» из UI',
      ...(count > SORT_FETCH_CAP ? { approximate: true } : {}),
      queries,
    });
  }),
);

server.registerTool(
  'ywm_popular',
  {
    description:
      'Топ-запросы хоста за неделю (search-queries/popular, до 3000): ' +
      '{ rows: [{ query, shows, clicks, avg_show_position, avg_click_position }] }. Фильтра по URL здесь нет.',
    inputSchema: {
      orderBy: z.enum(['TOTAL_SHOWS', 'TOTAL_CLICKS']).default('TOTAL_SHOWS'),
      device: deviceParam,
      dateFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      dateTo: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      limit: z.number().int().min(1).max(3000).default(500),
      hostId: z.string().optional().describe('Хост (по умолчанию YWM_HOST_ID из конфига)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const hostId = resolveHost(args.hostId, args.account);
    const userId = await getUserId(args.account);
    const rows: Array<Record<string, unknown>> = [];
    let offset = 0;

    while (rows.length < args.limit) {
      const limit = Math.min(500, args.limit - rows.length);
      const qs = new URLSearchParams({
        order_by: args.orderBy,
        device_type_indicator: args.device,
        offset: String(offset),
        limit: String(limit),
      });
      for (const ind of ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION']) {
        qs.append('query_indicator', ind);
      }
      if (args.dateFrom) qs.set('date_from', args.dateFrom);
      if (args.dateTo) qs.set('date_to', args.dateTo);

      const page = await ywmGet<{ queries: Array<{ query_text: string; indicators: Record<string, number> }> }>(
        `/user/${userId}/hosts/${encodeURIComponent(hostId)}/search-queries/popular?${qs}`,
        args.account,
      );
      const batch = page.queries ?? [];
      for (const q of batch) {
        rows.push({
          query: q.query_text,
          shows: q.indicators?.TOTAL_SHOWS ?? 0,
          clicks: q.indicators?.TOTAL_CLICKS ?? 0,
          avg_show_position: q.indicators?.AVG_SHOW_POSITION ?? null,
          avg_click_position: q.indicators?.AVG_CLICK_POSITION ?? null,
        });
      }
      if (batch.length < limit) break;
      offset += batch.length;
    }
    return jsonResult({ hostId, rowCount: rows.length, rows });
  }),
);

server.registerTool(
  'ywm_summary',
  {
    description: 'Сводка по хосту: ИКС (sqi), страниц в поиске (searchable_pages_count), исключено, число проблем сайта по важности.',
    inputSchema: { hostId: hostIdParam, account: accountParam },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const d = await ywmGet<Record<string, unknown>>(`${base}/summary`, args.account);
    return jsonResult({
      hostId,
      sqi: d.sqi ?? null,
      searchable_pages_count: d.searchable_pages_count ?? null,
      excluded_pages_count: d.excluded_pages_count ?? null,
      site_problems: d.site_problems ?? {},
    });
  }),
);

server.registerTool(
  'ywm_sqi_history',
  {
    description: 'История ИКС (индекс качества сайта) по датам: { points: [{ date, value }] }.',
    inputSchema: { hostId: hostIdParam, dateFrom: dateFromParam, dateTo: dateToParam, account: accountParam },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const { date_from, date_to } = dateRange(args.dateFrom, args.dateTo, 180);
    const d = await ywmGet<{ points?: unknown[] }>(`${base}/sqi-history?date_from=${date_from}&date_to=${date_to}`, args.account);
    return jsonResult({ hostId, date_from, date_to, points: d.points ?? [] });
  }),
);

server.registerTool(
  'ywm_indexing_history',
  {
    description: 'Динамика числа страниц В ПОИСКЕ по датам (search-urls/in-search): { history: [{ date, value }] }.',
    inputSchema: { hostId: hostIdParam, dateFrom: dateFromParam, dateTo: dateToParam, account: accountParam },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const { date_from, date_to } = dateRange(args.dateFrom, args.dateTo, 30);
    const d = await ywmGet<{ history?: unknown[] }>(
      `${base}/search-urls/in-search/history?date_from=${date_from}&date_to=${date_to}`,
      args.account,
    );
    return jsonResult({ hostId, date_from, date_to, history: d.history ?? [] });
  }),
);

server.registerTool(
  'ywm_external_links',
  {
    description:
      'Внешние ссылки на сайт (беклинки), выборка: { count (всего), links: [{ source_url, destination_url, discovery_date, source_last_access_date }] }.',
    inputSchema: {
      hostId: hostIdParam,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const d = await ywmGet<{ count?: number; links?: unknown[] }>(
      `${base}/links/external/samples?offset=${args.offset}&limit=${args.limit}`,
      args.account,
    );
    return jsonResult({ hostId, count: d.count ?? null, offset: args.offset, links: d.links ?? [] });
  }),
);

server.registerTool(
  'ywm_broken_links',
  {
    description:
      'Битые ссылки, выборка: внутренние (scope=internal) или внешние (external). { count, links: [{ source_url, destination_url, ... }] }.',
    inputSchema: {
      hostId: hostIdParam,
      scope: z.enum(['internal', 'external']).default('internal'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const d = await ywmGet<{ count?: number; links?: unknown[] }>(
      `${base}/links/${args.scope}/broken/samples?offset=${args.offset}&limit=${args.limit}`,
      args.account,
    );
    return jsonResult({ hostId, scope: args.scope, count: d.count ?? null, offset: args.offset, links: d.links ?? [] });
  }),
);

server.registerTool(
  'ywm_diagnostics',
  {
    description: 'Диагностика сайта Вебмастером — список проблем: { problems: [{ ... severity, state, ... }] }.',
    inputSchema: { hostId: hostIdParam, account: accountParam },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const d = await ywmGet<{ problems?: unknown }>(`${base}/diagnostics/`, args.account);
    return jsonResult({ hostId, problems: d.problems ?? [] });
  }),
);

server.registerTool(
  'ywm_important_urls',
  {
    description:
      'Мониторинг важных URL: { urls: [{ url, update_date, change_indicators, indexing_status, search_status }] } — статус индексации и изменения важных страниц.',
    inputSchema: { hostId: hostIdParam, account: accountParam },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const d = await ywmGet<{ urls?: unknown[] }>(`${base}/important-urls/`, args.account);
    return jsonResult({ hostId, count: (d.urls ?? []).length, urls: d.urls ?? [] });
  }),
);

server.registerTool(
  'ywm_sitemaps',
  {
    description:
      'Файлы Sitemap хоста со статусом: { sitemaps: [{ sitemap_id, sitemap_url, last_access_date, errors_count, urls_count, children_count, sources, sitemap_type }] }.',
    inputSchema: { hostId: hostIdParam, account: accountParam },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const d = await ywmGet<{ sitemaps?: unknown[] }>(`${base}/sitemaps`, args.account);
    return jsonResult({ hostId, count: (d.sitemaps ?? []).length, sitemaps: d.sitemaps ?? [] });
  }),
);

server.registerTool(
  'ywm_queries_history',
  {
    description:
      'История суммарной статистики запросов по хосту по датам (показы/клики/позиции): { indicators: {...} }. ' +
      'indicator: TOTAL_SHOWS | TOTAL_CLICKS | AVG_SHOW_POSITION | AVG_CLICK_POSITION.',
    inputSchema: {
      hostId: hostIdParam,
      indicator: z.enum(['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION']).default('TOTAL_SHOWS'),
      dateFrom: dateFromParam,
      dateTo: dateToParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const { date_from, date_to } = dateRange(args.dateFrom, args.dateTo, 30);
    const d = await ywmGet<{ indicators?: unknown }>(
      `${base}/search-queries/all/history?date_from=${date_from}&date_to=${date_to}&query_indicator=${args.indicator}`,
      args.account,
    );
    return jsonResult({ hostId, indicator: args.indicator, date_from, date_to, indicators: d.indicators ?? {} });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[ywm] MCP-сервер запущен (stdio)');
