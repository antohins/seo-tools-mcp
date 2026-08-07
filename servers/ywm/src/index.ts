#!/usr/bin/env node
/**
 * ywm-mcp — Яндекс.Вебмастер API v4 (read-only) для SEO-пайплайна.
 * Авторизация: OAuth-токен (YWM_OAUTH_TOKEN или общий YANDEX_OAUTH_TOKEN);
 * интерактивная авторизация — ywm_oauth_start/ywm_oauth_finish (code flow + авто-refresh).
 * Хост по умолчанию — YWM_HOST_ID из конфига (ywm_set_credentials), список — ywm_hosts.
 * Питает: BASELINE (Яндекс-сторона), A.5.
 *
 * Важно: фильтр по URL существует ТОЛЬКО в query-analytics/list (данные ~2 недели по умолчанию);
 * эндпоинта «рекомендованные запросы» в API v4 НЕТ — ywm_recommended_queries
 * аппроксимирует его через метрику DEMAND (спрос) + недобор кликов/позиций.
 * Чистая логика (HTTP-слой, пагинация, агрегация, даты, фильтры) — в queries.ts.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { accountParam, jsonResult, loadSharedEnv, registerAuthTools, registerYandexOauthTools, safeHandler } from '@seo-tools/shared';
import { z } from 'zod';
import {
  clearUserIdCache,
  dateRange,
  fetchPopular,
  filterRecommended,
  getUserId,
  queryAnalytics,
  resolveHost,
  SORT_FETCH_CAP,
  sortQueries,
  toQueryRow,
  validateOptionalDateOrder,
  ywmGet,
} from './queries.js';

loadSharedEnv();

const server = new McpServer({ name: 'ywm', version: '1.5.0' });

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
      clearUserIdCache();
    },
  },
);

registerYandexOauthTools(server, 'ywm', 'Яндекс.Вебмастер (hostinfo + verify), опционально + Метрика (чтение)', () => {
  clearUserIdCache();
});

const deviceParam = z.enum(['ALL', 'DESKTOP', 'MOBILE_AND_TABLET', 'MOBILE', 'TABLET']).default('ALL');

const hostIdParam = z
  .string()
  .optional()
  .describe('Хост Вебмастера (формат https:example.com:443); по умолчанию YWM_HOST_ID из конфига; список хостов — ywm_hosts');

/** Резолвит host + user_id и собирает префикс пути /user/{id}/hosts/{host}. */
async function hostCtx(hostId: string | undefined, account?: string): Promise<{ hostId: string; base: string }> {
  const h = resolveHost(hostId, account);
  const userId = await getUserId(account);
  return { hostId: h, base: `/user/${userId}/hosts/${encodeURIComponent(h)}` };
}

const dateFromParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('YYYY-MM-DD (по умолчанию — от дефолтного окна инструмента)');
const dateToParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('YYYY-MM-DD (по умолчанию сегодня по МСК)');

server.registerTool(
  'ywm_hosts',
  {
    description:
      'user_id токена и список сайтов в Вебмастере — для проверки доступа и настройки YWM_HOST_ID. ' +
      'Ответ: { user_id, hosts: [{ host_id, verified, ... }] } — host_id подставлять в параметр hostId других инструментов.',
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
      'Запросы Яндекса по конкретному URL (query-analytics, данные за ~2 недели по умолчанию — переопределяется dateFrom/dateTo): ' +
      '{ rows: [{ query, shows, clicks, ctr, position, demand }] }. ' +
      'url — путь («/oae/dubai/») или полный URL; сопоставление TEXT_CONTAINS по умолчанию. ' +
      'Без url — топ запросов всего хоста. ' +
      'truncated=true — запросов больше внутреннего капа (3000): топ отсортирован по первым 3000 строкам выборки API.',
    inputSchema: {
      url: z.string().optional().describe('Путь или URL страницы; пусто = весь хост'),
      urlMatch: z.enum(['TEXT_CONTAINS', 'TEXT_MATCH']).default('TEXT_CONTAINS'),
      device: deviceParam,
      orderBy: z
        .enum(['IMPRESSIONS', 'CLICKS', 'CTR', 'POSITION', 'DEMAND'])
        .default('IMPRESSIONS')
        .describe('Поле сортировки результата (после агрегации)'),
      dateFrom: dateFromParam,
      dateTo: dateToParam,
      limit: z.number().int().min(1).max(3000).default(500).describe('Сколько строк вернуть (дефолт 500, максимум 3000)'),
      hostId: hostIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const hostId = resolveHost(args.hostId, args.account);
    validateOptionalDateOrder(args.dateFrom, args.dateTo);
    const body: Record<string, unknown> = {
      text_indicator: 'QUERY',
      device_type_indicator: args.device,
    };
    if (args.dateFrom) body.date_from = args.dateFrom;
    if (args.dateTo) body.date_to = args.dateTo;
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
    const rows = sortQueries(items.map(toQueryRow), args.orderBy).slice(0, args.limit);
    const truncated = count > SORT_FETCH_CAP;
    return jsonResult({
      hostId,
      url: args.url ?? null,
      totalQueries: count,
      rowCount: rows.length,
      truncated, // true: запросов больше капа — топ отсортирован по первым SORT_FETCH_CAP строкам выборки API
      ...(truncated
        ? { note: `запросов ${count} > ${SORT_FETCH_CAP}: топ отсортирован по первым ${SORT_FETCH_CAP} строкам выборки API` }
        : {}),
      rows,
    });
  }),
);

server.registerTool(
  'ywm_recommended_queries',
  {
    description:
      'Недобранные запросы по URL (аппроксимация: в API v4 нет «рекомендованных»). Берём запросы ТРЁХ категорий: ' +
      'показы без кликов, позиция за топ-10, любой запрос со спросом (DEMAND > 0) — категория указана в поле reason. ' +
      'Ответ: { queries: [{ query, demand, shows, clicks, position, reason }] }. ' +
      'truncated=true — запросов больше внутреннего капа (3000): фильтр применён к первым 3000 строкам выборки API.',
    inputSchema: {
      url: z.string().describe('Путь («/oae/dubai/») или полный URL страницы'),
      device: deviceParam,
      limit: z.number().int().min(1).max(1000).default(200).describe('Сколько запросов вернуть (дефолт 200, максимум 1000)'),
      hostId: hostIdParam,
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
    const queries = filterRecommended(items.map(toQueryRow), args.limit);
    return jsonResult({
      hostId,
      url: args.url,
      note: 'аппроксимация: API v4 не отдаёт «рекомендованные запросы» из UI',
      truncated: count > SORT_FETCH_CAP, // true: запросов больше капа — фильтр применён к первым SORT_FETCH_CAP строкам
      queries,
    });
  }),
);

server.registerTool(
  'ywm_popular',
  {
    description:
      'Топ-запросы хоста за неделю (search-queries/popular, до 3000): ' +
      '{ rows: [{ query, shows, clicks, avg_show_position, avg_click_position }] }. Фильтра по URL здесь нет. ' +
      'truncated=true — набран ровно limit: за ним могли остаться строки (увеличь limit).',
    inputSchema: {
      orderBy: z.enum(['TOTAL_SHOWS', 'TOTAL_CLICKS']).default('TOTAL_SHOWS'),
      device: deviceParam,
      dateFrom: dateFromParam,
      dateTo: dateToParam,
      limit: z.number().int().min(1).max(3000).default(500).describe('Сколько строк вернуть (дефолт 500, максимум 3000)'),
      hostId: hostIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const hostId = resolveHost(args.hostId, args.account);
    validateOptionalDateOrder(args.dateFrom, args.dateTo);
    // пагинация (обрыв по короткой странице, эвристика truncated) — fetchPopular в queries.ts
    const { rows, truncated } = await fetchPopular(
      hostId,
      { orderBy: args.orderBy, device: args.device, limit: args.limit, dateFrom: args.dateFrom, dateTo: args.dateTo },
      args.account,
    );
    return jsonResult({ hostId, rowCount: rows.length, truncated, rows });
  }),
);

server.registerTool(
  'ywm_summary',
  {
    description:
      'Сводка по хосту. Ответ: { sqi (ИКС), searchable_pages_count (страниц в поиске), excluded_pages_count (исключено), ' +
      'site_problems (число проблем сайта по важности) }.',
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
    description: 'История ИКС (индекс качества сайта) по датам: { points: [{ date, value }] }. Окно по умолчанию — 180 дней.',
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
    description:
      'Динамика числа страниц В ПОИСКЕ по датам (search-urls/in-search): { history: [{ date, value }] }. Окно по умолчанию — 30 дней.',
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
      'Внешние ссылки на сайт (беклинки), выборка: { count (всего), links: [{ source_url, destination_url, discovery_date, source_last_access_date }] }. ' +
      'truncated=true — за выборкой есть ещё строки (добирай offset).',
    inputSchema: {
      hostId: hostIdParam,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50).describe('Размер выборки (дефолт 50, максимум 100)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const d = await ywmGet<{ count?: number; links?: unknown[] }>(
      `${base}/links/external/samples?offset=${args.offset}&limit=${args.limit}`,
      args.account,
    );
    const links = d.links ?? [];
    const count = d.count ?? null;
    // truncated по count из ответа API; без count — эвристика «страница заполнена»
    const truncated = count !== null ? args.offset + links.length < count : links.length === args.limit;
    return jsonResult({ hostId, count, offset: args.offset, truncated, links });
  }),
);

server.registerTool(
  'ywm_broken_links',
  {
    description:
      'Битые ссылки, выборка: внутренние (scope=internal) или внешние (external). { count, links: [{ source_url, destination_url, ... }] }. ' +
      'truncated=true — за выборкой есть ещё строки (добирай offset).',
    inputSchema: {
      hostId: hostIdParam,
      scope: z.enum(['internal', 'external']).default('internal'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50).describe('Размер выборки (дефолт 50, максимум 100)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const { hostId, base } = await hostCtx(args.hostId, args.account);
    const d = await ywmGet<{ count?: number; links?: unknown[] }>(
      `${base}/links/${args.scope}/broken/samples?offset=${args.offset}&limit=${args.limit}`,
      args.account,
    );
    const links = d.links ?? [];
    const count = d.count ?? null;
    const truncated = count !== null ? args.offset + links.length < count : links.length === args.limit;
    return jsonResult({ hostId, scope: args.scope, count, offset: args.offset, truncated, links });
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
      'indicator: TOTAL_SHOWS | TOTAL_CLICKS | AVG_SHOW_POSITION | AVG_CLICK_POSITION. Окно по умолчанию — 30 дней.',
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
