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
 * фактическую таймзону возвращаем в ответе (timeZone) — кроме ga4_realtime:
 * у runRealtimeReport блока metadata нет, и полей-пустышек мы не выдумываем.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { accountParam, jsonResult, loadSharedEnv, registerAuthTools, safeHandler, withToolDefaults } from '@seo-tools/shared';
import { createGoogleAuth, registerGoogleOauthTools } from '@seo-tools/shared/google';
import { z } from 'zod';
import {
  buildDimensionFilter,
  buildFunnelBody,
  buildMetricFilter,
  buildReportBody,
  FUNNEL_BREAKDOWN_TOTAL,
  flattenAccountSummaries,
  forbidden403Hint,
  funnelTruncation,
  type Ga4FilterInput,
  type Ga4FunnelStepInput,
  type Ga4MetricFilterInput,
  type Ga4Property,
  incompatibleFieldsFromError,
  markFunnelTotals,
  parseAnnotations,
  parseCompatibility,
  parseMetadata,
  parsePropertyDetails,
  parsePropertyQuota,
  parseReport,
  resolveProperty,
  validateAbsoluteDateRange,
} from './logic.js';

loadSharedEnv();

const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN_API = 'https://analyticsadmin.googleapis.com/v1beta';
// воронки и аннотации существуют ТОЛЬКО в alpha-версиях — в v1beta этих методов нет
const DATA_API_ALPHA = 'https://analyticsdata.googleapis.com/v1alpha';
const ADMIN_API_ALPHA = 'https://analyticsadmin.googleapis.com/v1alpha';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
// порт отличается от gsc (8585): серверы могут работать одновременно
const OAUTH_PORT = Number(process.env.GA4_OAUTH_PORT || 8586); // реальный env процесса — ок
const LIST_DEADLINE_MS = 2 * 60_000; // потолок на весь обход страниц ga4_list_properties

const auth = createGoogleAuth({
  toolPrefix: 'ga4',
  scope: SCOPE,
  refreshEnv: 'GA4_REFRESH_TOKEN',
  saJsonEnv: 'GA4_SA_JSON',
  apiName: 'Google Analytics API (Data + Admin)',
  noAuthHint: (account) =>
    `Нет авторизации GA4${account ? ` для аккаунта «${account}»` : ''}. ` +
    `Либо OAuth: ga4_oauth_start${account ? ` (account="${account}")` : ''} → ссылка → ga4_oauth_finish (токен видит все свойства аккаунта), ` +
    'либо сервис-аккаунт: ga4_save_sa_json / ga4_set_credentials (GA4_SA_JSON) + добавить его email в свойство GA4. ' +
    'Текущий статус ключей и инструкция — ga4_auth_status.',
  forbiddenHint: forbidden403Hint,
  quotaHint:
    'У Data API квоты считаются «токенами» на СВОЙСТВО, тремя раздельными корзинами (Core / Realtime / Funnel), ' +
    'почасово и посуточно; тяжёлые запросы съедают их быстрее — уменьши limit и число измерений, разбей период ' +
    'или подожди восстановления. (У Admin API — ga4_list_properties — квоты отдельные, там помогает только пауза.)',
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
  compareStartDate?: string;
  compareEndDate?: string;
  metricFilters?: Ga4MetricFilterInput[];
  includeTotals?: boolean;
  includeQuota?: boolean;
  account?: string;
}) {
  const body = buildReportBody({ ...args, returnPropertyQuota: args.includeQuota });
  const data = await auth.googleFetch<any>(
    `${DATA_API}/${args.property}:runReport`,
    { method: 'POST', body: JSON.stringify(body) },
    args.account,
    args.property,
  );
  const quota = parsePropertyQuota(data);
  const report = { ...parseReport(data, { offset: args.offset }), ...(quota ? { quota } : {}) };
  // limit в GA4 — на ВЕСЬ ответ, а не на каждый период: при сравнении строки двух периодов
  // делят общий лимит по единому ранжированию, поэтому пары могут быть неполными
  if (args.compareStartDate && args.compareEndDate && report.truncated) {
    return {
      ...report,
      note:
        `limit=${args.limit} действует на весь ответ, а не на каждый период: строки current и previous делят его между собой ` +
        'по общему ранжированию, поэтому часть строк осталась без пары. Увеличь limit (ориентировочно вдвое) для полного сопоставления.',
    };
  }
  return report;
}

/** Общие параметры отчётов: период, лимит, профиль. */
const reportInput = {
  propertyId: z.string().optional().describe('Числовой id свойства GA4 (или properties/123). По умолчанию — GA4_PROPERTY_ID'),
  startDate: z.string().default('28daysAgo').describe('YYYY-MM-DD или ключевое слово GA4: today, yesterday, NdaysAgo'),
  endDate: z.string().default('yesterday').describe('YYYY-MM-DD или ключевое слово GA4'),
  limit: z.number().int().min(1).max(100_000).default(100).describe('Сколько строк вернуть (в ответе totalRows/truncated)'),
  // сравнение периодов и итоги доступны во ВСЕХ отчётных инструментах
  compareStartDate: z
    .string()
    .optional()
    .describe('Начало периода сравнения (вместе с compareEndDate). В строках появится колонка dateRange: current/previous'),
  compareEndDate: z.string().optional().describe('Конец периода сравнения'),
  includeTotals: z.boolean().default(false).describe('Добавить итоги по метрикам (поле totals; при сравнении — по строке на период)'),
  includeQuota: z
    .boolean()
    .default(false)
    .describe('Добавить остаток квоты свойства (поле quota): сколько «токенов» Data API съел запрос и сколько осталось на час/сутки'),
  account: accountParam,
};

// withToolDefaults проставляет всем инструментам readOnlyHint/openWorldHint и title
const server = withToolDefaults(new McpServer({ name: 'ga4', version: '1.7.0' }));

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
      'Свойства GA4, доступные авторизации (Admin API accountSummaries, с полным обходом страниц). ' +
      'Возвращает { propertyId, displayName, account, accountName } — propertyId нужен всем остальным инструментам ' +
      '(это НЕ Measurement ID G-XXXXXXX). Заодно проверка доступов.',
    inputSchema: { account: accountParam },
  },
  safeHandler(async (args) => {
    // pageSize=200 — максимум Admin API, поэтому у крупных агентств (>200 аккаунтов)
    // обязателен обход по nextPageToken, иначе часть свойств просто не видна
    const properties: Ga4Property[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    const deadline = Date.now() + LIST_DEADLINE_MS;
    do {
      const qs = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
      // attempts:2 — при 20 страницах дефолтные 3 ретрая × 120 с таймаута растянули бы вызов на десятки минут
      const data = await auth.googleFetch<any>(`${ADMIN_API}/accountSummaries?${qs}`, { method: 'GET', attempts: 2 }, args.account);
      properties.push(...flattenAccountSummaries(data));
      pageToken = data?.nextPageToken ? String(data.nextPageToken) : undefined;
    } while (pageToken && ++pages < 20 && Date.now() < deadline); // страховки: число страниц и общий дедлайн
    return jsonResult({ count: properties.length, properties, truncated: Boolean(pageToken) });
  }),
);

server.registerTool(
  'ga4_metadata',
  {
    description:
      'Какие измерения и метрики доступны В ЭТОМ свойстве GA4 (Data API getMetadata), включая КАСТОМНЫЕ ' +
      '(customEvent:… / customUser:…). ВЫЗЫВАТЬ ПЕРЕД ga4_report, если не уверен в именах полей: ' +
      'их сотни (порядка 375 измерений и 119 метрик), и точные API-имена не угадываются. ' +
      'search — подстрока по имени/описанию; customOnly — только кастомные поля свойства. ' +
      'ВАЖНО: у метрики может быть blockedReasons — по такой отчёт вернёт ОДНИ НУЛИ без ошибки, ' +
      'а metricFilters по ней упадёт с 400. Поле type подсказывает, целое или дробное класть в metricFilters.',
    inputSchema: {
      propertyId: z.string().optional().describe('Числовой id свойства (по умолчанию GA4_PROPERTY_ID)'),
      search: z.string().optional().describe('Подстрока для поиска (регистронезависимо), например "landing", "revenue", "organic"'),
      customOnly: z.boolean().default(false).describe('Только кастомные определения свойства'),
      limit: z.number().int().min(1).max(200).default(50).describe('Сколько полей каждого типа вернуть'),
      withDescriptions: z
        .boolean()
        .default(false)
        .describe('Включить описания полей (ответ вырастет в разы; поиск по описанию работает всегда)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const data = await auth.googleFetch<any>(`${DATA_API}/${property}/metadata`, { method: 'GET' }, args.account, property);
    return jsonResult({
      property,
      ...parseMetadata(data, {
        search: args.search,
        customOnly: args.customOnly,
        limit: args.limit,
        withDescriptions: args.withDescriptions,
      }),
    });
  }),
);

server.registerTool(
  'ga4_check_compatibility',
  {
    description:
      'Совместима ли связка измерений/метрик В ЭТОМ свойстве (Data API checkCompatibility) — проверка БЕЗ тяжёлого отчёта. ' +
      'compatible=true означает, что такой отчёт пройдёт; при false в incompatibleFields — поля, которые GA4 просит убрать. ' +
      'Дополнительно возвращает canAddDimensions/canAddMetrics — что ЕЩЁ можно добавить к этому запросу, сохранив совместимость. ' +
      'Совместимость зависит от свойства: например, метрики Search Console (organicGoogleSearchClicks и др.) работают только ' +
      'при связке GA4 ↔ Search Console, иначе не сочетаются ни с одним измерением. ' +
      'Фильтры тоже влияют на совместимость — передавай те же filters/metricFilters, что и в будущем отчёте.',
    inputSchema: {
      propertyId: z.string().optional().describe('Числовой id свойства (по умолчанию GA4_PROPERTY_ID)'),
      dimensions: z.array(z.string()).default([]).describe('Проверяемые измерения'),
      metrics: z.array(z.string()).default([]).describe('Проверяемые метрики'),
      filters: z
        .array(
          z.object({
            dimension: z.string(),
            matchType: z.enum(['EXACT', 'BEGINS_WITH', 'ENDS_WITH', 'CONTAINS', 'FULL_REGEXP', 'PARTIAL_REGEXP']),
            value: z.string(),
            caseSensitive: z.boolean().optional(),
            not: z.boolean().optional(),
          }),
        )
        .optional()
        .describe('Те же фильтры по измерениям, что пойдут в отчёт (они участвуют в проверке совместимости)'),
      metricFilters: z
        .array(
          z.object({
            metric: z.string(),
            operation: z.enum(['EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL', 'GREATER_THAN', 'GREATER_THAN_OR_EQUAL']),
            value: z.number(),
          }),
        )
        .optional()
        .describe('Те же фильтры по метрикам, что пойдут в отчёт'),
      limit: z.number().int().min(1).max(200).default(40).describe('Сколько «можно добавить»-полей вернуть'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    if (!args.dimensions.length && !args.metrics.length) {
      throw new Error('Укажи хотя бы одно измерение или метрику для проверки совместимости.');
    }
    const dimFilter = buildDimensionFilter(args.filters);
    const metFilter = buildMetricFilter(args.metricFilters);
    const body = {
      ...(args.dimensions.length ? { dimensions: args.dimensions.map((name) => ({ name })) } : {}),
      ...(args.metrics.length ? { metrics: args.metrics.map((name) => ({ name })) } : {}),
      ...(dimFilter ? { dimensionFilter: dimFilter } : {}),
      ...(metFilter ? { metricFilter: metFilter } : {}),
      compatibilityFilter: 'COMPATIBLE',
    };
    const requested = { dimensions: args.dimensions, metrics: args.metrics };
    /** Одиночная проверка: совместимо ли подмножество полей (true/false). */
    const isCompatible = async (dims: string[], mets: string[]): Promise<boolean> => {
      try {
        await auth.googleFetch<any>(
          `${DATA_API}/${property}:checkCompatibility`,
          {
            method: 'POST',
            body: JSON.stringify({
              ...(dims.length ? { dimensions: dims.map((name) => ({ name })) } : {}),
              ...(mets.length ? { metrics: mets.map((name) => ({ name })) } : {}),
              compatibilityFilter: 'COMPATIBLE',
            }),
          },
          args.account,
          property,
        );
        return true;
      } catch {
        return false;
      }
    };
    try {
      const data = await auth.googleFetch<any>(
        `${DATA_API}/${property}:checkCompatibility`,
        { method: 'POST', body: JSON.stringify(body) },
        args.account,
        property,
      );
      // успех = сама связка совместима; в ответе — то, что можно ДОБАВИТЬ (сотни полей, режем)
      return jsonResult({ property, requested, compatible: true, ...parseCompatibility(data, args.limit) });
    } catch (err) {
      // метод специально ПАДАЕТ на несовместимой связке — это валидный вердикт, а не сбой
      const message = err instanceof Error ? err.message : String(err);
      let bad = incompatibleFieldsFromError(message);
      if (!bad.length && !/incompatible/i.test(message)) throw err;
      // GA4 у этого метода отвечает коротким «The dimensions and metrics are incompatible»
      // без имён полей, поэтому виновника ищем сами — методом ИСКЛЮЧЕНИЯ: поле виновно, если
      // без него остальной набор становится совместимым. (Проверять «поле + все метрики» нельзя:
      // плохая метрика остаётся в наборе, и виновными выглядят все поля подряд.)
      // Число проб ограничено, чтобы не разогнать квоту на большом запросе.
      const fields = [...args.metrics.map((n) => ({ n, metric: true })), ...args.dimensions.map((n) => ({ n, metric: false }))];
      if (!bad.length && fields.length > 1 && fields.length <= 8) {
        const probes = await Promise.all(
          fields.map(async (f) => {
            const dims = f.metric ? args.dimensions : args.dimensions.filter((d) => d !== f.n);
            const mets = f.metric ? args.metrics.filter((m) => m !== f.n) : args.metrics;
            if (!dims.length && !mets.length) return null; // пустой набор проверять бессмысленно
            return (await isCompatible(dims, mets)) ? f.n : null;
          }),
        );
        bad = probes.filter((x): x is string => Boolean(x));
      }
      return jsonResult({
        property,
        requested,
        compatible: false,
        incompatibleFields: bad,
        note: bad.length
          ? `Не сочетаются с остальным запросом: ${bad.join(', ')} — убери их или замени измерения. ` +
            '(Метрики Search Console требуют связки GA4 ↔ Search Console.)'
          : 'GA4 считает связку несовместимой, но не назвал поле. Проверь поля по одному этим же инструментом.',
        apiMessage: message.slice(0, 300),
      });
    }
  }),
);

server.registerTool(
  'ga4_report',
  {
    description:
      'Произвольный отчёт GA4 (Data API runReport): любые измерения × метрики, фильтры по измерениям и по значениям метрик, ' +
      'сортировка, сравнение периодов (compareStartDate/compareEndDate) и итоги (includeTotals). ' +
      'Если не уверен в именах полей — сначала ga4_metadata; если боишься 400 «incompatible» — ga4_check_compatibility. ' +
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
      metricFilters: z
        .array(
          z.object({
            metric: z.string().describe('Имя метрики, например sessions'),
            operation: z.enum(['EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL', 'GREATER_THAN', 'GREATER_THAN_OR_EQUAL']),
            value: z.number(),
          }),
        )
        .optional()
        .describe('Фильтры по ЗНАЧЕНИЯМ метрик (между собой — AND), например sessions > 50 — отсечь шумовые строки'),
      orderBy: z.string().optional().describe('Метрика или измерение для сортировки (обязано быть в metrics/dimensions этого запроса)'),
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
      'Топ страниц GA4: по URL страницы (pagePath), заголовку или странице входа. ' +
      'groupBy=landing использует landingPagePlusQueryString (у устаревшего landingPage с 2023 обрезается query string, ' +
      'и цифры расходятся с отчётом «Целевая страница» в интерфейсе GA4). ' +
      'organicOnly=true — только органический поиск (полезно для SEO-аналитики посадочных).',
    inputSchema: {
      ...reportInput,
      groupBy: z.enum(['page', 'landing', 'title']).default('page'),
      metrics: z.array(z.string()).default(['screenPageViews', 'sessions', 'activeUsers', 'engagementRate']),
      organicOnly: z.boolean().default(false).describe('Только Organic Search'),
      pathContains: z
        .string()
        .optional()
        .describe('Фильтр по подстроке пути (CONTAINS): по группирующему измерению, а при groupBy=title — по pagePath'),
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const dim = args.groupBy === 'page' ? 'pagePath' : args.groupBy === 'landing' ? 'landingPagePlusQueryString' : 'pageTitle';
    const filters: Ga4FilterInput[] = [];
    if (args.organicOnly) filters.push({ dimension: 'sessionDefaultChannelGroup', matchType: 'EXACT', value: 'Organic Search' });
    // фильтр по пути всегда идёт по pagePath: при groupBy=title фильтрация по заголовку
    // дала бы пустой результат, хотя параметр обещает подстроку URL
    // Фильтруем ПО ГРУППИРУЮЩЕМУ измерению: при groupBy=landing фильтр по pagePath дал бы
    // «лендинги сессий, где вообще просматривали /blog», а не «лендинги внутри /blog»
    // (landingPagePlusQueryString — session-scope, pagePath — event-scope).
    // Исключение — groupBy=title: заголовок не путь, поэтому подстрока пути идёт по pagePath.
    if (args.pathContains) {
      filters.push({ dimension: args.groupBy === 'title' ? 'pagePath' : dim, matchType: 'CONTAINS', value: args.pathContains });
    }
    const report = await runReport({ ...args, property, dimensions: [dim], filters, orderBy: args.metrics[0] });
    return jsonResult({ property, groupBy: args.groupBy, dimension: dim, startDate: args.startDate, endDate: args.endDate, ...report });
  }),
);

server.registerTool(
  'ga4_events',
  {
    description:
      'События GA4: количество событий и пользователей по eventName. ' +
      'keyEventsOnly=true — оставить ТОЛЬКО ключевые события (бывшие конверсии): фильтр по измерению isKeyEvent + метрика keyEvents ' +
      '(и измерение, и метрика есть не во всех свойствах — если API ответит ошибкой по полю, вызови с keyEventsOnly=false).',
    inputSchema: {
      ...reportInput,
      metrics: z.array(z.string()).default(['eventCount', 'activeUsers']),
      keyEventsOnly: z.boolean().default(false).describe('Только ключевые события: фильтр isKeyEvent=true + метрика keyEvents'),
      eventName: z.string().optional().describe('Точное имя события для фильтра'),
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const metrics = args.keyEventsOnly ? [...new Set([...args.metrics, 'keyEvents'])] : args.metrics;
    const filters: Ga4FilterInput[] = [];
    if (args.eventName) filters.push({ dimension: 'eventName', matchType: 'EXACT', value: args.eventName });
    // ключевые события отсекаются ФИЛЬТРОМ по isKeyEvent (переименовано из isConversionEvent):
    // одной лишь метрики keyEvents мало — без фильтра в выдачу попадают все события подряд
    if (args.keyEventsOnly) filters.push({ dimension: 'isKeyEvent', matchType: 'EXACT', value: 'true' });
    const report = await runReport({ ...args, property, dimensions: ['eventName'], metrics, filters, orderBy: metrics[0] });
    // Пустой результат при keyEventsOnly — почти всегда «ключевые события не размечены»,
    // а не «их не было»: фильтр EXACT «true» отсекает всё молча, без ошибки API
    const note =
      args.keyEventsOnly && report.count === 0
        ? 'Ключевых событий не найдено. Проверь, что события отмечены как ключевые в GA4 (Администратор → События), ' +
          'и что период выбран верно; для сверки вызови этот же инструмент с keyEventsOnly=false.'
        : undefined;
    return jsonResult({
      property,
      keyEventsOnly: args.keyEventsOnly,
      startDate: args.startDate,
      endDate: args.endDate,
      ...report,
      ...(note ? { note } : {}),
    });
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
    // withMetadata:false — у realtime-ответа нет блока metadata (ни timeZone, ни currency, ни порога)
    return jsonResult({ property, realtime: true, ...parseReport(data, { withMetadata: false }) });
  }),
);

server.registerTool(
  'ga4_funnel',
  {
    description:
      'Воронка GA4 (Data API runFunnelReport, v1alpha): сколько пользователей дошло до каждого шага и где отвалились. ' +
      'Шаг задаётся событием (eventName) и/или условиями по измерениям. Минимум ДВА шага. ' +
      'openFunnel=false (по умолчанию) — закрытая воронка: считаются только те, кто вошёл через ПЕРВЫЙ шаг; ' +
      'true — пользователь может войти на любом шаге. isDirectlyFollowedBy — шаг обязан идти сразу за предыдущим. ' +
      'breakdownDimension разбивает воронку по измерению (deviceCategory, sessionSourceMedium…); ' +
      'у каждого шага появляется строка-ИТОГ с меткой "(всего)" — складывать её с остальными нельзя. ' +
      'ВНИМАНИЕ 1: внутри ШАГОВ действует схема Exploration API, а НЕ обычная схема отчётов — ' +
      'часть измерений там недоступна, в том числе pagePath (брать pagePathPlusQueryString, pageLocation ' +
      'или unifiedPagePathScreen). ga4_metadata на шаги воронки не распространяется. ' +
      'ВНИМАНИЕ 2: у воронок СВОЯ корзина квоты Data API, и запрос дорогой — порядка 10 «токенов» против 1 у обычного отчёта.',
    inputSchema: {
      propertyId: z.string().optional().describe('Числовой id свойства (по умолчанию GA4_PROPERTY_ID)'),
      startDate: z.string().default('28daysAgo').describe('YYYY-MM-DD или ключевое слово GA4'),
      endDate: z.string().default('yesterday').describe('YYYY-MM-DD или ключевое слово GA4'),
      steps: z
        .array(
          z.object({
            name: z.string().describe('Человекочитаемое имя шага, попадёт в ответ'),
            eventName: z.string().optional().describe('Событие GA4: page_view, view_item, add_to_cart, begin_checkout, purchase…'),
            filters: z
              .array(
                z.object({
                  dimension: z.string(),
                  matchType: z.enum(['EXACT', 'BEGINS_WITH', 'ENDS_WITH', 'CONTAINS', 'FULL_REGEXP', 'PARTIAL_REGEXP']),
                  value: z.string(),
                  caseSensitive: z.boolean().optional(),
                  not: z.boolean().optional(),
                }),
              )
              .optional()
              .describe('Условия по измерениям (с eventName объединяются через AND)'),
            isDirectlyFollowedBy: z.boolean().optional().describe('Шаг должен идти СРАЗУ после предыдущего (на первом шаге игнорируется)'),
            withinMinutesFromPriorStep: z.number().positive().optional().describe('Не позже N минут после предыдущего шага'),
          }),
        )
        .min(2)
        .describe('Шаги воронки по порядку, минимум два'),
      openFunnel: z.boolean().default(false).describe('true — открытая воронка (вход на любом шаге)'),
      breakdownDimension: z.string().optional().describe('Измерение для разбивки воронки, например deviceCategory'),
      breakdownLimit: z.number().int().min(1).max(15).optional().describe('Сколько значений разбивки оставить (по умолчанию — решает GA4)'),
      filters: z
        .array(
          z.object({
            dimension: z.string(),
            matchType: z.enum(['EXACT', 'BEGINS_WITH', 'ENDS_WITH', 'CONTAINS', 'FULL_REGEXP', 'PARTIAL_REGEXP']),
            value: z.string(),
            caseSensitive: z.boolean().optional(),
            not: z.boolean().optional(),
          }),
        )
        .optional()
        .describe('Фильтр по ВСЕЙ воронке (не по отдельному шагу)'),
      limit: z.number().int().min(1).max(10_000).default(100).describe('Сколько строк таблицы воронки вернуть'),
      includeQuota: z.boolean().default(false).describe('Добавить остаток квоты (у воронок корзина своя)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    const body = buildFunnelBody({ ...args, steps: args.steps as Ga4FunnelStepInput[], returnPropertyQuota: args.includeQuota });
    const data = await auth.googleFetch<any>(
      // воронки живут ТОЛЬКО в v1alpha — в v1beta этого метода нет
      `${DATA_API_ALPHA}/${property}:runFunnelReport`,
      { method: 'POST', body: JSON.stringify(body) },
      args.account,
      property,
    );
    // funnelTable — обычный отчёт по форме (заголовки + строки), но БЕЗ блока metadata
    const table = parseReport(data?.funnelTable, { withMetadata: false });
    const { rows, hasTotals } = markFunnelTotals(table.rows, args.breakdownDimension);
    const truncated = funnelTruncation(rows.length, args.limit, Boolean(args.breakdownDimension));
    const quota = parsePropertyQuota(data);
    return jsonResult({
      property,
      startDate: args.startDate,
      endDate: args.endDate,
      openFunnel: Boolean(args.openFunnel),
      steps: args.steps.map((s: { name: string }) => s.name),
      ...table,
      rows,
      truncated,
      ...(truncated === true ? { limitNote: `Строк ровно limit=${args.limit} — хвост обрезан. Увеличь limit.` } : {}),
      ...(truncated === null
        ? {
            limitNote:
              'truncated=null: полноту определить нельзя. API воронок не возвращает rowCount, а с разбивкой limit ' +
              `действует внутри шага — число строк про обрезку ничего не говорит. Нужна уверенность — повтори с бо́льшим limit (сейчас ${args.limit}) и сравни.`,
          }
        : {}),
      ...(hasTotals
        ? {
            note:
              `У каждого шага есть строка с ${args.breakdownDimension}="${FUNNEL_BREAKDOWN_TOTAL}" — это ИТОГ по шагу, ` +
              'а не ещё одно значение разбивки: складывать его с остальными строками шага нельзя.',
          }
        : {}),
      ...(quota ? { quota } : {}),
    });
  }),
);

server.registerTool(
  'ga4_annotations',
  {
    description:
      'Аннотации свойства GA4 (Admin API reportingDataAnnotations, v1alpha) — пометки на датах: релизы, редизайны, ' +
      'рекламные кампании, а также сгенерированные самой GA4 (systemGenerated=true). ' +
      'ВЫЗЫВАТЬ, когда в динамике виден необъяснимый скачок или провал: аннотация часто и есть объяснение. ' +
      'Аннотация бывает на одну дату (date) или на период (date + endDate).',
    inputSchema: {
      propertyId: z.string().optional().describe('Числовой id свойства (по умолчанию GA4_PROPERTY_ID)'),
      startDate: z
        .string()
        .optional()
        .describe('Оставить аннотации, пересекающие период. Строго YYYY-MM-DD: ключевые слова GA4 здесь НЕ работают (фильтр Admin API)'),
      endDate: z.string().optional().describe('Конец периода (YYYY-MM-DD)'),
      limit: z.number().int().min(1).max(200).default(100).describe('Сколько аннотаций вернуть'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    if (Boolean(args.startDate) !== Boolean(args.endDate)) {
      throw new Error('Для фильтра по периоду нужны ОБА параметра: startDate и endDate.');
    }
    const qs = new URLSearchParams({ pageSize: String(Math.min(args.limit, 200)) });
    if (args.startDate && args.endDate) {
      validateAbsoluteDateRange(args.startDate, args.endDate);
      // Серверный фильтр Admin API: аннотация пересекается с периодом. Хвост «= true»
      // обязателен — это предикат, а не вызов-условие: без него API отвечает 400
      // INVALID_ARGUMENT без единого намёка на причину.
      qs.set('filter', `is_annotation_in_range("${args.startDate}", "${args.endDate}") = true`);
    }
    const data = await auth.googleFetch<any>(
      `${ADMIN_API_ALPHA}/${property}/reportingDataAnnotations?${qs}`,
      { method: 'GET' },
      args.account,
      property,
    );
    return jsonResult({ property, ...parseAnnotations(data, args.limit) });
  }),
);

server.registerTool(
  'ga4_property_details',
  {
    description:
      'Карточка свойства GA4 (Admin API): таймзона отчётов, валюта, отрасль, уровень сервиса (STANDARD или 360 — от него ' +
      'зависят квоты и сэмплирование), дата создания и ПОТОКИ ДАННЫХ с их Measurement ID (G-XXXXXXX). ' +
      'ВЫЗЫВАТЬ, когда даты в отчётах не сходятся с ожидаемыми (GA4 считает сутки в таймзоне свойства, не в UTC) ' +
      'или когда нужно сопоставить свойство с кодом счётчика на сайте.',
    inputSchema: {
      propertyId: z.string().optional().describe('Числовой id свойства (по умолчанию GA4_PROPERTY_ID)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const property = resolveProperty(args.propertyId, args.account);
    // Потоки — отдельный вызов, и он может не пройти (нет прав, 429, 5xx). Ронять из-за
    // этого карточку не нужно, но и молча отдавать dataStreams:[] нельзя: пустой список
    // читается как «у свойства нет веб-потока и Measurement ID» — то есть ровно тот факт,
    // ради которого инструмент и зовут, оказался бы выдуманным. Ошибку показываем.
    const [details, streams] = await Promise.all([
      auth.googleFetch<any>(`${ADMIN_API}/${property}`, { method: 'GET' }, args.account, property),
      auth
        .googleFetch<any>(`${ADMIN_API}/${property}/dataStreams?pageSize=50`, { method: 'GET' }, args.account, property)
        .catch((err: unknown) => ({ __error: err instanceof Error ? err.message : String(err) })),
    ]);
    const streamsError = (streams as { __error?: string }).__error;
    return jsonResult({
      ...parsePropertyDetails(details, streamsError ? {} : streams),
      ...(streamsError
        ? {
            dataStreamsError: `Список потоков получить не удалось, поэтому dataStreams пуст НЕ потому, что потоков нет: ${streamsError.slice(0, 300)}`,
          }
        : {}),
    });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[ga4] MCP-сервер запущен (stdio)');
