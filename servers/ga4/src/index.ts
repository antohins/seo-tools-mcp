#!/usr/bin/env node
/**
 * ga4-mcp — Google Analytics 4 для SEO-пайплайна: произвольные отчёты Data API
 * (ga4_report), временные ряды, источники трафика, гео, устройства, топ страниц,
 * события и realtime. Все инструменты read-only, вывод — строгий JSON.
 *
 * Авторизация — та же, что у gsc (общий модуль @seo-tools/shared/google):
 *  1) OAuth пользователя (ga4_oauth_start/finish) — токен видит ВСЕ свойства аккаунта;
 *  2) service account (GA4_SA_JSON) — для headless-кронов; email аккаунта нужно
 *     добавить в свойство GA4 вручную.
 *
 * Даты GA4 считаются в таймзоне СВОЙСТВА, поэтому локальное «сегодня» не вычисляем:
 * принимаем YYYY-MM-DD и родные ключевые слова (today/yesterday/NdaysAgo), а
 * фактическую таймзону возвращаем в ответе (timeZone).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { accountParam, jsonResult, loadSharedEnv, registerAuthTools, safeHandler } from '@seo-tools/shared';
import { createGoogleAuth, registerGoogleOauthTools } from '@seo-tools/shared/google';
import { z } from 'zod';
import { buildReportBody, flattenAccountSummaries, forbidden403Hint, type Ga4FilterInput, parseReport, resolveProperty } from './logic.js';

loadSharedEnv();

const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
// порт отличается от gsc (8585): серверы могут работать одновременно
const OAUTH_PORT = Number(process.env.GA4_OAUTH_PORT || 8586); // реальный env процесса — ок

const auth = createGoogleAuth({
  toolPrefix: 'ga4',
  scope: SCOPE,
  refreshEnv: 'GA4_REFRESH_TOKEN',
  saJsonEnv: 'GA4_SA_JSON',
  apiName: 'Google Analytics Data API',
  noAuthHint: (account) =>
    `Нет авторизации GA4${account ? ` для аккаунта «${account}»` : ''}. ` +
    `Либо OAuth: ga4_oauth_start${account ? ` (account="${account}")` : ''} → ссылка → ga4_oauth_finish (токен видит все свойства аккаунта), ` +
    'либо сервис-аккаунт: ga4_save_sa_json / ga4_set_credentials (GA4_SA_JSON) + добавить его email в свойство GA4. ' +
    'Текущий статус ключей и инструкция — ga4_auth_status.',
  forbiddenHint: forbidden403Hint,
});

/** runReport по свойству: собирает тело, шлёт и нормализует ответ. */
async function runReport(args: {
  property: string;
  startDate: string;
  endDate: string;
  dimensions: string[];
  metrics: string[];
  filters?: Ga4FilterInput[];
  orderBy?: string;
  orderDesc?: boolean;
  limit: number;
  offset?: number;
  keepEmptyRows?: boolean;
  account?: string;
}) {
  const body = buildReportBody(args);
  const data = await auth.googleFetch<any>(
    `${DATA_API}/${args.property}:runReport`,
    { method: 'POST', body: JSON.stringify(body) },
    args.account,
    args.property,
  );
  return parseReport(data, args.limit);
}

/** Общие параметры отчётов: период, лимит, профиль. */
const reportInput = {
  propertyId: z.string().optional().describe('Числовой id свойства GA4 (или properties/123). По умолчанию — GA4_PROPERTY_ID'),
  startDate: z.string().default('28daysAgo').describe('YYYY-MM-DD или ключевое слово GA4: today, yesterday, NdaysAgo'),
  endDate: z.string().default('yesterday').describe('YYYY-MM-DD или ключевое слово GA4'),
  limit: z.number().int().min(1).max(100_000).default(100).describe('Сколько строк вернуть (в ответе totalRows/truncated)'),
  account: accountParam,
};

const server = new McpServer({ name: 'ga4', version: '1.6.0' });

registerAuthTools(
  server,
  'ga4',
  [
    { env: 'GOOGLE_CLIENT_ID', label: 'OAuth client ID из Google Cloud (для пути OAuth)', secret: false, required: false },
    { env: 'GOOGLE_CLIENT_SECRET', label: 'OAuth client secret из Google Cloud', required: false },
    { env: 'GA4_REFRESH_TOKEN', label: 'Refresh-токен OAuth (получается через ga4_oauth_start/finish)', required: false },
    { env: 'GA4_SA_JSON', label: 'Путь к JSON-ключу сервис-аккаунта (альтернативный путь)', secret: false, required: false },
    { env: 'GA4_PROPERTY_ID', label: 'Свойство GA4 по умолчанию (числовой id, например 123456789)', secret: false, required: false },
  ],
  {
    help:
      'Два пути. РЕКОМЕНДУЕМЫЙ — OAuth (токен видит ВСЕ свойства твоего Google-аккаунта): ' +
      '1) console.cloud.google.com → проект → включить Google Analytics Data API и Google Analytics Admin API; ' +
      '2) APIs & Services → OAuth consent screen: External, добавить себя в Test users (или Publish app для долгоживущего токена); ' +
      '3) Credentials → Create credentials → OAuth client ID → тип Desktop app → взять client ID и secret; ' +
      '4) ga4_oauth_start → открыть ссылку → разрешить → ga4_oauth_finish. ' +
      'АЛЬТЕРНАТИВА — сервис-аккаунт (для кронов): IAM → Service Accounts → JSON-ключ → ga4_save_sa_json → ' +
      'добавить email аккаунта в GA4 (Администратор → Управление доступом к ресурсу, роль «Просмотр»). ' +
      'Если OAuth уже настроен для gsc — GOOGLE_CLIENT_ID/SECRET переиспользуются, нужен только свой ga4_oauth_start/finish (другой scope). ' +
      'Проверка — ga4_list_properties.',
    requireAnyOf: [['GA4_REFRESH_TOKEN', 'GA4_SA_JSON']],
    onSave: auth.resetCaches,
  },
);

registerGoogleOauthTools(server, {
  prefix: 'ga4',
  scope: SCOPE,
  refreshEnv: 'GA4_REFRESH_TOKEN',
  saJsonEnv: 'GA4_SA_JSON',
  port: OAUTH_PORT,
  portEnv: 'GA4_OAUTH_PORT',
  auth,
  accessSummary: 'доступ ко ВСЕМ свойствам Google Analytics этого аккаунта',
  apiName: 'Google Analytics Data API + Admin API',
  checkTool: 'ga4_list_properties',
  saNextHint:
    'Добавь этот email в GA4 → Администратор → Управление доступом к ресурсу (роль «Просмотр»), затем проверь ga4_list_properties.',
});

server.registerTool(
  'ga4_list_properties',
  {
    description:
      'Свойства GA4, доступные авторизации (Admin API accountSummaries). Возвращает { propertyId, displayName, account, accountName } — ' +
      'propertyId нужен всем остальным инструментам (это НЕ Measurement ID G-XXXXXXX). Заодно проверка доступов.',
    inputSchema: { account: accountParam },
  },
  safeHandler(async (args) => {
    const data = await auth.googleFetch<any>(`${ADMIN_API}/accountSummaries?pageSize=200`, { method: 'GET' }, args.account);
    const properties = flattenAccountSummaries(data);
    return jsonResult({ count: properties.length, properties, truncated: Boolean(data?.nextPageToken) });
  }),
);

server.registerTool(
  'ga4_report',
  {
    description:
      'Произвольный отчёт GA4 (Data API runReport): любые измерения × метрики, фильтры, сортировка. ' +
      'Имена — как в API: измерения (date, sessionSourceMedium, pagePath, country, deviceCategory, eventName…), ' +
      'метрики (activeUsers, newUsers, sessions, screenPageViews, engagedSessions, engagementRate, bounceRate, ' +
      'averageSessionDuration, eventCount, keyEvents, totalRevenue…). ' +
      'ВНИМАНИЕ: bounceRate/engagementRate GA4 возвращает ДОЛЕЙ (0..1), не процентами. ' +
      'В ответе timeZone свойства, totalRows и truncated; thresholded=true — часть данных скрыта порогом конфиденциальности.',
    inputSchema: {
      ...reportInput,
      dimensions: z.array(z.string()).default([]).describe('Измерения GA4, максимум 9 (пусто — только итоги по метрикам)'),
      metrics: z.array(z.string()).min(1).describe('Метрики GA4, максимум 10'),
      filters: z
        .array(
          z.object({
            dimension: z.string(),
            matchType: z.enum(['EXACT', 'BEGINS_WITH', 'ENDS_WITH', 'CONTAINS', 'FULL_REGEXP', 'PARTIAL_REGEXP']),
            value: z.string(),
            caseSensitive: z.boolean().optional(),
            not: z.boolean().optional().describe('Инвертировать условие'),
          }),
        )
        .optional()
        .describe('Фильтры по измерениям (между собой — AND)'),
      orderBy: z.string().optional().describe('Метрика или измерение для сортировки'),
      orderDesc: z.boolean().default(true).describe('Сортировать по убыванию'),
      offset: z.number().int().min(0).optional().describe('Смещение для постраничного обхода'),
      keepEmptyRows: z.boolean().default(false).describe('Возвращать строки с нулями'),
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const report = await runReport({ ...args, property });
    return jsonResult({ property, startDate: args.startDate, endDate: args.endDate, ...report });
  }),
);

server.registerTool(
  'ga4_bytime',
  {
    description:
      'Динамика метрик GA4 по времени: разбивка по дате/неделе/месяцу/часу. ' +
      'Возвращает строки {date|week|month|hour, <метрики>} в хронологическом порядке.',
    inputSchema: {
      ...reportInput,
      metrics: z
        .array(z.string())
        .default(['sessions', 'activeUsers', 'screenPageViews'])
        .describe('Метрики GA4 (по умолчанию sessions, activeUsers, screenPageViews)'),
      period: z.enum(['date', 'week', 'month', 'hour']).default('date').describe('Гранулярность ряда'),
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    // родные измерения GA4; сортируем по самому измерению (хронология).
    // Для недель/месяцев берём yearWeek/yearMonth, а не week/month: последние — номер внутри
    // года (00–53 / 01–12), и ряд, пересекающий границу года, сортировался бы неверно.
    const dim = args.period === 'date' ? 'date' : args.period === 'hour' ? 'dateHour' : args.period === 'week' ? 'yearWeek' : 'yearMonth';
    const report = await runReport({
      ...args,
      property,
      dimensions: [dim],
      orderBy: dim,
      orderDesc: false,
    });
    return jsonResult({ property, period: args.period, startDate: args.startDate, endDate: args.endDate, ...report });
  }),
);

server.registerTool(
  'ga4_traffic_sources',
  {
    description:
      'Источники трафика GA4: сессии/пользователи/вовлечённость по каналу или источнику-каналу. ' +
      'groupBy=channel — стандартные группы каналов (Organic Search, Direct, Referral…), source_medium — «google / organic».',
    inputSchema: {
      ...reportInput,
      groupBy: z.enum(['channel', 'source_medium', 'source', 'medium', 'campaign']).default('channel'),
      metrics: z.array(z.string()).default(['sessions', 'activeUsers', 'engagedSessions', 'engagementRate']),
      organicOnly: z.boolean().default(false).describe('Только органический поиск (sessionDefaultChannelGroup = Organic Search)'),
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const dim =
      args.groupBy === 'channel'
        ? 'sessionDefaultChannelGroup'
        : args.groupBy === 'source_medium'
          ? 'sessionSourceMedium'
          : args.groupBy === 'source'
            ? 'sessionSource'
            : args.groupBy === 'medium'
              ? 'sessionMedium'
              : 'sessionCampaignName';
    const filters: Ga4FilterInput[] = args.organicOnly
      ? [{ dimension: 'sessionDefaultChannelGroup', matchType: 'EXACT', value: 'Organic Search' }]
      : [];
    const report = await runReport({
      ...args,
      property,
      dimensions: [dim],
      filters,
      orderBy: args.metrics[0],
    });
    return jsonResult({ property, groupBy: args.groupBy, startDate: args.startDate, endDate: args.endDate, ...report });
  }),
);

server.registerTool(
  'ga4_geo',
  {
    description: 'География GA4: сессии/пользователи по стране, региону или городу.',
    inputSchema: {
      ...reportInput,
      groupBy: z.enum(['country', 'region', 'city']).default('country'),
      metrics: z.array(z.string()).default(['sessions', 'activeUsers', 'engagementRate']),
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const report = await runReport({ ...args, property, dimensions: [args.groupBy], orderBy: args.metrics[0] });
    return jsonResult({ property, groupBy: args.groupBy, startDate: args.startDate, endDate: args.endDate, ...report });
  }),
);

server.registerTool(
  'ga4_devices',
  {
    description: 'Устройства GA4: сессии/пользователи по типу устройства, ОС или браузеру.',
    inputSchema: {
      ...reportInput,
      groupBy: z.enum(['device', 'os', 'browser']).default('device'),
      metrics: z.array(z.string()).default(['sessions', 'activeUsers', 'engagementRate']),
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const dim = args.groupBy === 'device' ? 'deviceCategory' : args.groupBy === 'os' ? 'operatingSystem' : 'browser';
    const report = await runReport({ ...args, property, dimensions: [dim], orderBy: args.metrics[0] });
    return jsonResult({ property, groupBy: args.groupBy, startDate: args.startDate, endDate: args.endDate, ...report });
  }),
);

server.registerTool(
  'ga4_top_pages',
  {
    description:
      'Топ страниц GA4: по URL страницы (pagePath), заголовку или странице входа (landingPage). ' +
      'organicOnly=true — только органический поиск (полезно для SEO-аналитики посадочных).',
    inputSchema: {
      ...reportInput,
      groupBy: z.enum(['page', 'landing', 'title']).default('page'),
      metrics: z.array(z.string()).default(['screenPageViews', 'sessions', 'activeUsers', 'engagementRate']),
      organicOnly: z.boolean().default(false).describe('Только Organic Search'),
      pathContains: z.string().optional().describe('Фильтр по подстроке пути (CONTAINS)'),
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const dim = args.groupBy === 'page' ? 'pagePath' : args.groupBy === 'landing' ? 'landingPage' : 'pageTitle';
    const filters: Ga4FilterInput[] = [];
    if (args.organicOnly) filters.push({ dimension: 'sessionDefaultChannelGroup', matchType: 'EXACT', value: 'Organic Search' });
    if (args.pathContains) filters.push({ dimension: dim, matchType: 'CONTAINS', value: args.pathContains });
    const report = await runReport({ ...args, property, dimensions: [dim], filters, orderBy: args.metrics[0] });
    return jsonResult({ property, groupBy: args.groupBy, startDate: args.startDate, endDate: args.endDate, ...report });
  }),
);

server.registerTool(
  'ga4_events',
  {
    description:
      'События GA4: количество событий и пользователей по eventName. ' +
      'keyEventsOnly=true — только ключевые события (бывшие конверсии; метрика keyEvents доступна не во всех свойствах — ' +
      'если API вернёт ошибку по метрике, вызови с keyEventsOnly=false).',
    inputSchema: {
      ...reportInput,
      metrics: z.array(z.string()).default(['eventCount', 'activeUsers']),
      keyEventsOnly: z.boolean().default(false).describe('Считать только ключевые события (добавляет метрику keyEvents)'),
      eventName: z.string().optional().describe('Точное имя события для фильтра'),
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const metrics = args.keyEventsOnly ? [...new Set([...args.metrics, 'keyEvents'])] : args.metrics;
    const filters: Ga4FilterInput[] = args.eventName ? [{ dimension: 'eventName', matchType: 'EXACT', value: args.eventName }] : [];
    const report = await runReport({ ...args, property, dimensions: ['eventName'], metrics, filters, orderBy: metrics[0] });
    return jsonResult({ property, startDate: args.startDate, endDate: args.endDate, ...report });
  }),
);

server.registerTool(
  'ga4_realtime',
  {
    description:
      'Realtime-отчёт GA4 (последние 30 минут, runRealtimeReport): активные пользователи с разбивкой. ' +
      'Периода дат у него нет; доступен ограниченный набор измерений/метрик.',
    inputSchema: {
      propertyId: z.string().optional().describe('Числовой id свойства GA4 (по умолчанию GA4_PROPERTY_ID)'),
      dimensions: z
        .array(z.string())
        .default(['country'])
        .describe('Realtime-измерения: country, city, deviceCategory, unifiedScreenName, eventName…'),
      metrics: z.array(z.string()).default(['activeUsers']).describe('Realtime-метрики: activeUsers, screenPageViews, eventCount'),
      limit: z.number().int().min(1).max(10_000).default(50),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const body: Record<string, unknown> = {
      dimensions: args.dimensions.map((name) => ({ name })),
      metrics: args.metrics.map((name) => ({ name })),
      limit: args.limit,
    };
    const data = await auth.googleFetch<any>(
      `${DATA_API}/${property}:runRealtimeReport`,
      { method: 'POST', body: JSON.stringify(body) },
      args.account,
      property,
    );
    return jsonResult({ property, realtime: true, ...parseReport(data, args.limit) });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[ga4] MCP-сервер запущен (stdio)');
