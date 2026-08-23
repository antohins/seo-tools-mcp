#!/usr/bin/env node
/**
 * metrika-mcp — Яндекс.Метрика Stat API (read-only) для SEO-пайплайна.
 * Авторизация: общий YANDEX_OAUTH_TOKEN (одно OAuth-приложение с сервером ywm; интерактивная
 * выдача — metrika_oauth_start/finish) или отдельный METRIKA_OAUTH_TOKEN (перекрывает общий);
 * токен обновляется автоматически при протухании. Дефолтный счётчик — METRIKA_COUNTER_ID
 * (список — metrika_counters). Мультиаккаунт — параметр account у каждого инструмента.
 * Чистая логика (даты, валидации, кэш целей, HTTP-слой) — в utils.ts, регистрация — здесь.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  accountParam,
  jsonResult,
  loadSharedEnv,
  registerAuthTools,
  registerYandexOauthTools,
  safeHandler,
  withToolDefaults,
} from '@seo-tools/shared';
import { z } from 'zod';
import { landingFilter } from './filters.js';
import { mapReportRows, shortKey } from './report.js';
import {
  accuracyError,
  clipGoalIds,
  createGoalsCache,
  fetchGoals,
  GOALS_MAX,
  isTruncated,
  mapLandingTotals,
  metrikaDates,
  mgmtGet,
  resolveCounterId,
  SESSION_METRICS,
  sampleShareField,
  statBytime,
  statQuery,
  statQueryAll,
  validateDateRange,
} from './utils.js';

loadSharedEnv();

const getGoals = createGoalsCache(fetchGoals);

/** Универсальный отчёт Stat API /data → строки + totals + флаги сэмплирования/обрезки. */
async function runReport(
  o: {
    id: string;
    dimensions: string[];
    metrics: string[];
    date1: string;
    date2: string;
    filters?: string;
    sort?: string;
    limit: number;
    accuracy: string;
  },
  account?: string,
) {
  const res = await statQueryAll(
    {
      ids: o.id,
      dimensions: o.dimensions.join(',') || undefined,
      metrics: o.metrics.join(','),
      date1: o.date1,
      date2: o.date2,
      filters: o.filters,
      sort: o.sort,
      accuracy: o.accuracy,
    },
    o.limit,
    account,
  );
  const rows = mapReportRows(res, o.dimensions, o.metrics);
  return {
    rows,
    totals: res.totals ?? null,
    totalRows: res.total_rows ?? null,
    truncated: isTruncated(res.total_rows, rows.length),
    sampled: res.sampled ?? false,
    ...sampleShareField(res),
  };
}

const counterIdParam = z.number().int().optional().describe('Номер счётчика (по умолчанию METRIKA_COUNTER_ID)');
const date1Param = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('YYYY-MM-DD (по умолчанию 30 дней назад; «сегодня» — по МСК)');
const date2Param = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('YYYY-MM-DD (по умолчанию сегодня; «сегодня» — по МСК)');

// withToolDefaults проставляет всем инструментам readOnlyHint/openWorldHint и title
const server = withToolDefaults(new McpServer({ name: 'metrika', version: '1.7.0' }));

registerAuthTools(
  server,
  'metrika',
  [
    { env: 'YANDEX_OAUTH_TOKEN', label: 'Общий OAuth-токен Яндекса (Вебмастер+Метрика)', required: false },
    { env: 'METRIKA_OAUTH_TOKEN', label: 'Отдельный токен Метрики (перекрывает общий; обычно не нужен)', required: false },
    { env: 'YANDEX_CLIENT_ID', label: 'ClientID OAuth-приложения Яндекса (для авторизации/refresh)', secret: false, required: false },
    { env: 'YANDEX_CLIENT_SECRET', label: 'Client secret OAuth-приложения Яндекса', required: false },
    { env: 'METRIKA_COUNTER_ID', label: 'Номер счётчика по умолчанию', secret: false, required: false },
  ],
  {
    help:
      'Нужен OAuth-токен со scope «Яндекс.Метрика: получение статистики» (metrika:read). Быстрый путь: ' +
      'metrika_oauth_start (одно приложение с правами Метрики И Вебмастера даёт общий токен для обоих серверов) → ' +
      'пользователь открывает ссылку → код → metrika_oauth_finish. Затем задать METRIKA_COUNTER_ID ' +
      '(список — metrika_counters).',
    requireAnyOf: [['YANDEX_OAUTH_TOKEN', 'METRIKA_OAUTH_TOKEN']],
  },
);

registerYandexOauthTools(server, 'metrika', 'Яндекс.Метрика (получение статистики), опционально + Вебмастер (hostinfo + verify)');

server.registerTool(
  'metrika_counters',
  {
    description:
      'Список счётчиков Метрики, доступных токену — для проверки доступа и выбора METRIKA_COUNTER_ID. ' +
      'Запрашивает до 10 000; если счётчиков больше — truncated: true.',
    inputSchema: {
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const data = await mgmtGet<{ rows?: number; counters?: Array<{ id: number; name: string; site2?: { site: string } }> }>(
      '/counters?rows=10000',
      args.account,
    );
    const counters = (data.counters ?? []).map((c) => ({ id: c.id, name: c.name, site: c.site2?.site ?? null }));
    const totalRows = data.rows ?? counters.length;
    return jsonResult({ account: args.account ?? null, counters, totalRows, truncated: totalRows > counters.length });
  }),
);

const commonInput = {
  landingPage: z.string().describe('Страница входа: путь (/oae/dubai/) или полный URL'),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('YYYY-MM-DD'),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe('YYYY-MM-DD'),
  counterId: counterIdParam,
  account: accountParam,
};

server.registerTool(
  'metrika_landing_behavior',
  {
    description:
      'Поведение на странице входа: visits, bounceRate (процент отказов, 0–100), pageDepth, avgVisitDurationSeconds ' +
      '+ достижения целей. source=organic фильтрует органический трафик (ym:s:lastTrafficSource — атрибуция ' +
      'по последнему значимому источнику). goalIds — список ID целей для goalReaches (без него цели ' +
      'подтягиваются автоматически из счётчика, максимум 10 — излишек отбрасывается с маркером goals_truncated).',
    inputSchema: {
      ...commonInput,
      source: z
        .enum(['organic', 'all'])
        .default('organic')
        .describe('organic — только органика (атрибуция по последнему значимому источнику), all — весь трафик'),
      searchEngine: z.enum(['all', 'yandex', 'google']).default('all').describe('Дополнительно сузить до конкретного поисковика'),
      goalIds: z
        .array(z.number().int())
        .optional()
        .describe(`ID целей для goalReaches (максимум ${GOALS_MAX}); без него — авто из счётчика`),
    },
  },
  safeHandler(async (args) => {
    const id = resolveCounterId(args.counterId, args.account);
    validateDateRange(args.startDate, args.endDate, 'startDate', 'endDate');

    const filters: string[] = [landingFilter(args.landingPage)];
    if (args.source === 'organic') filters.push(`ym:s:lastTrafficSource=='organic'`);
    if (args.searchEngine !== 'all') filters.push(`ym:s:lastSearchEngineRoot=='${args.searchEngine}'`);

    // цели: либо явные, либо все из счётчика (через кэш — они меняются редко)
    let goalIds = args.goalIds ?? [];
    const goalNames = new Map<number, string>();
    let goalsLoaded: boolean | null = null; // null — цели заданы явно, загрузки не было
    if (!goalIds.length) {
      try {
        const goals = await getGoals(id, args.account);
        for (const g of goals) {
          goalIds.push(g.id);
          goalNames.set(g.id, g.name);
        }
        goalsLoaded = true;
      } catch (err) {
        goalsLoaded = false;
        console.error(`[metrika] не смог получить список целей: ${String(err)}`);
      }
    }
    const clipped = clipGoalIds(goalIds);
    goalIds = clipped.goalIds;

    const goalMetrics = goalIds.map((g) => `ym:s:goal${g}reaches`);

    const res = await statQuery(
      {
        ids: id,
        date1: args.startDate,
        date2: args.endDate,
        metrics: [...SESSION_METRICS, ...goalMetrics].join(','),
        filters: filters.join(' AND '),
        accuracy: 'full',
      },
      args.account,
    );

    const totals = res.totals ?? res.data[0]?.metrics ?? [];
    const base = mapLandingTotals(totals, goalIds, goalNames);

    return jsonResult({
      landingPage: args.landingPage,
      startDate: args.startDate,
      endDate: args.endDate,
      source: args.source,
      ...base,
      ...(goalsLoaded !== null ? { goals_loaded: goalsLoaded } : {}),
      ...(goalsLoaded === false ? { goals_error: true } : {}),
      ...(clipped.truncated ? { goals_truncated: true, goals_dropped: clipped.dropped } : {}),
      sampled: res.sampled ?? false,
      ...sampleShareField(res),
    });
  }),
);

server.registerTool(
  'metrika_search_phrases',
  {
    description:
      'Поисковые фразы (в основном Яндекс — Google шифрует) c поведением по странице входа. ' +
      'Возвращает { landingPage, rowCount, totalRows, truncated, sampled, rows: [{ phrase, visits, ' +
      'bounceRate (процент отказов, 0–100), pageDepth, avgVisitDurationSeconds }] }; truncated: true — строки обрезаны limit.',
    inputSchema: {
      landingPage: z
        .string()
        .optional()
        .describe('Страница входа: путь (/oae/dubai/) или полный URL. Без него — органические фразы по всему счётчику'),
      startDate: commonInput.startDate,
      endDate: commonInput.endDate,
      counterId: commonInput.counterId,
      account: commonInput.account,
      limit: z.number().int().min(1).max(50_000).default(1000),
    },
  },
  safeHandler(async (args) => {
    const id = resolveCounterId(args.counterId, args.account);
    validateDateRange(args.startDate, args.endDate, 'startDate', 'endDate');
    // всегда органика; страница входа — опциональное сужение
    const filters = [`ym:s:lastTrafficSource=='organic'`, 'ym:s:searchPhrase!n'];
    if (args.landingPage) filters.push(landingFilter(args.landingPage));
    const res = await statQueryAll(
      {
        ids: id,
        date1: args.startDate,
        date2: args.endDate,
        dimensions: 'ym:s:searchPhrase',
        metrics: 'ym:s:visits,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds',
        filters: filters.join(' AND '),
        sort: '-ym:s:visits',
        accuracy: 'full',
      },
      args.limit,
      args.account,
    );
    const rows = res.data.map((r) => ({
      phrase: r.dimensions[0]?.name ?? '',
      visits: r.metrics[0] ?? 0,
      bounceRate: r.metrics[1] ?? 0, // проценты (0–100), как отдаёт Метрика
      pageDepth: r.metrics[2] ?? 0,
      avgVisitDurationSeconds: r.metrics[3] ?? 0,
    }));
    const totalRows = res.total_rows ?? rows.length;
    return jsonResult({
      landingPage: args.landingPage ?? null,
      rowCount: rows.length,
      totalRows,
      truncated: totalRows > rows.length,
      sampled: res.sampled ?? false,
      ...sampleShareField(res),
      rows,
    });
  }),
);

server.registerTool(
  'metrika_top_landings',
  {
    description:
      'Топ страниц входа из органики за период. Возвращает { rowCount, totalRows, truncated, sampled, ' +
      'rows: [{ landing, visits, bounceRate (процент отказов, 0–100), pageDepth, avgVisitDurationSeconds }] }; ' +
      'truncated: true — строки обрезаны limit.',
    inputSchema: {
      startDate: commonInput.startDate,
      endDate: commonInput.endDate,
      counterId: commonInput.counterId,
      account: commonInput.account,
      limit: z.number().int().min(1).max(10_000).default(200),
    },
  },
  safeHandler(async (args) => {
    const id = resolveCounterId(args.counterId, args.account);
    validateDateRange(args.startDate, args.endDate, 'startDate', 'endDate');
    const res = await statQueryAll(
      {
        ids: id,
        date1: args.startDate,
        date2: args.endDate,
        dimensions: 'ym:s:startURLPath',
        metrics: 'ym:s:visits,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds',
        filters: `ym:s:lastTrafficSource=='organic'`,
        sort: '-ym:s:visits',
        accuracy: 'full',
      },
      args.limit,
      args.account,
    );
    const rows = res.data.map((r) => ({
      landing: r.dimensions[0]?.name ?? '',
      visits: r.metrics[0] ?? 0,
      bounceRate: r.metrics[1] ?? 0, // проценты (0–100), как отдаёт Метрика
      pageDepth: r.metrics[2] ?? 0,
      avgVisitDurationSeconds: r.metrics[3] ?? 0,
    }));
    const totalRows = res.total_rows ?? rows.length;
    return jsonResult({
      rowCount: rows.length,
      totalRows,
      truncated: totalRows > rows.length,
      sampled: res.sampled ?? false,
      ...sampleShareField(res),
      rows,
    });
  }),
);

server.registerTool(
  'metrika_report',
  {
    description:
      'Произвольный отчёт Stat API: любые измерения × метрики Метрики. Даёт полный доступ к отчётам. ' +
      'dimensions/metrics — имена вида ym:s:<name> (визиты) или ym:pv:<name> (просмотры), напр. ' +
      'ym:s:lastTrafficSource, ym:s:deviceCategory, ym:s:regionCity; метрики ym:s:visits, ym:s:users, ym:s:bounceRate. ' +
      'Ключи в ответе — короткие, без неймспейса (ym:s:regionCity → regionCity); bounceRate — процент отказов (0–100). ' +
      'Ответ: { rows, totals, totalRows, truncated, sampled }.',
    inputSchema: {
      metrics: z.array(z.string()).min(1).describe('Метрики, напр. ["ym:s:visits","ym:s:users","ym:s:bounceRate"]'),
      dimensions: z.array(z.string()).default([]).describe('Измерения (можно пусто — тогда только totals)'),
      date1: date1Param,
      date2: date2Param,
      filters: z
        .string()
        .optional()
        .describe(
          "Выражение фильтра Метрики. Примеры: ym:s:lastTrafficSource=='organic'; " +
            "AND/OR — ym:s:regionCountryName=='Россия' AND ym:s:deviceCategory=='desktop'; " +
            "IN — ym:s:browser IN ('Chrome','YaBrowser'); апостроф/бэкслеш в значении экранируются бэкслешем (\\')",
        ),
      sort: z.string().optional().describe('Сортировка, напр. -ym:s:visits'),
      limit: z.number().int().min(1).max(50_000).default(1000),
      accuracy: z.string().default('full').describe('low | medium | high | full | доля выборки (0,1], напр. 0.1'),
      counterId: counterIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const accErr = accuracyError(args.accuracy);
    if (accErr) throw new Error(accErr);
    const id = resolveCounterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
    validateDateRange(date1, date2);
    const rep = await runReport(
      {
        id,
        dimensions: args.dimensions,
        metrics: args.metrics,
        date1,
        date2,
        filters: args.filters,
        sort: args.sort,
        limit: args.limit,
        accuracy: args.accuracy,
      },
      args.account,
    );
    return jsonResult({ counter: id, date1, date2, dimensions: args.dimensions, metrics: args.metrics, rowCount: rep.rows.length, ...rep });
  }),
);

server.registerTool(
  'metrika_bytime',
  {
    description:
      'Динамика метрик по времени (Stat API /bytime): каждая метрика — временной ряд. ' +
      'group: day | week | month | hour. Возвращает { time_intervals, series: [{ …измерения, metrics }], ' +
      'truncated (ряды обрезаны limit), sampled }.',
    inputSchema: {
      metrics: z.array(z.string()).min(1).describe('Метрики, напр. ["ym:s:visits","ym:s:users"]'),
      dimensions: z.array(z.string()).default([]).describe('Измерения (напр. ["ym:s:lastTrafficSource"]) — отдельный ряд на значение'),
      group: z.enum(['day', 'week', 'month', 'hour']).default('day'),
      date1: date1Param,
      date2: date2Param,
      filters: z.string().optional().describe("Выражение фильтра Метрики, напр. ym:s:lastTrafficSource=='organic'"),
      limit: z.number().int().min(1).max(1000).default(100),
      counterId: counterIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const id = resolveCounterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
    validateDateRange(date1, date2);
    const res = await statBytime(
      {
        ids: id,
        metrics: args.metrics.join(','),
        dimensions: args.dimensions.join(',') || undefined,
        group: args.group,
        date1,
        date2,
        filters: args.filters,
        limit: args.limit,
        accuracy: 'full',
      },
      args.account,
    );
    const series = res.data.map((r) => {
      const dims: Record<string, unknown> = {};
      args.dimensions.forEach((d, i) => {
        dims[shortKey(d)] = r.dimensions[i]?.name ?? null;
      });
      const metrics: Record<string, number[]> = {};
      args.metrics.forEach((m, i) => {
        metrics[shortKey(m)] = r.metrics[i] ?? [];
      });
      return { ...dims, metrics };
    });
    return jsonResult({
      counter: id,
      group: args.group,
      date1,
      date2,
      time_intervals: res.time_intervals ?? [],
      truncated: isTruncated(res.total_rows, series.length),
      sampled: res.sampled ?? false,
      ...sampleShareField(res),
      series,
    });
  }),
);

server.registerTool(
  'metrika_traffic_sources',
  {
    description:
      'Источники трафика: визиты/пользователи/отказы/глубина/длительность по ym:s:lastTrafficSource (organic/direct/ad/referral/social/…). ' +
      'bounceRate — процент отказов (0–100).',
    inputSchema: {
      date1: date1Param,
      date2: date2Param,
      limit: z.number().int().min(1).max(1000).default(20),
      counterId: counterIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const id = resolveCounterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
    validateDateRange(date1, date2);
    const rep = await runReport(
      {
        id,
        dimensions: ['ym:s:lastTrafficSource'],
        metrics: SESSION_METRICS,
        date1,
        date2,
        sort: '-ym:s:visits',
        limit: args.limit,
        accuracy: 'full',
      },
      args.account,
    );
    return jsonResult({ counter: id, date1, date2, ...rep });
  }),
);

server.registerTool(
  'metrika_geo',
  {
    description:
      'География визитов: распределение по странам/регионам/городам. level: country | region | city. bounceRate — процент (0–100).',
    inputSchema: {
      level: z.enum(['country', 'region', 'city']).default('city'),
      date1: date1Param,
      date2: date2Param,
      limit: z.number().int().min(1).max(1000).default(50),
      counterId: counterIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const id = resolveCounterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
    validateDateRange(date1, date2);
    const dim = { country: 'ym:s:regionCountry', region: 'ym:s:regionArea', city: 'ym:s:regionCity' }[args.level];
    const rep = await runReport(
      { id, dimensions: [dim], metrics: SESSION_METRICS, date1, date2, sort: '-ym:s:visits', limit: args.limit, accuracy: 'full' },
      args.account,
    );
    return jsonResult({ counter: id, level: args.level, date1, date2, ...rep });
  }),
);

server.registerTool(
  'metrika_devices',
  {
    description: 'Технологии визитов: распределение по устройствам/ОС/браузерам. by: device | os | browser. bounceRate — процент (0–100).',
    inputSchema: {
      by: z.enum(['device', 'os', 'browser']).default('device'),
      date1: date1Param,
      date2: date2Param,
      limit: z.number().int().min(1).max(1000).default(50),
      counterId: counterIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const id = resolveCounterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
    validateDateRange(date1, date2);
    const dim = { device: 'ym:s:deviceCategory', os: 'ym:s:operatingSystem', browser: 'ym:s:browser' }[args.by];
    const rep = await runReport(
      { id, dimensions: [dim], metrics: SESSION_METRICS, date1, date2, sort: '-ym:s:visits', limit: args.limit, accuracy: 'full' },
      args.account,
    );
    return jsonResult({ counter: id, by: args.by, date1, date2, ...rep });
  }),
);

server.registerTool(
  'metrika_goals',
  {
    description: 'Список целей счётчика (id, name, type) — для отчётов по конверсиям (метрика ym:s:goal<ID>reaches).',
    inputSchema: { counterId: counterIdParam, account: accountParam },
  },
  safeHandler(async (args) => {
    const id = resolveCounterId(args.counterId, args.account);
    const data = await mgmtGet<{ goals?: Array<{ id: number; name: string; type: string }> }>(`/counter/${id}/goals`, args.account);
    return jsonResult({ counter: id, goals: (data.goals ?? []).map((g) => ({ id: g.id, name: g.name, type: g.type })) });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[metrika] MCP-сервер запущен (stdio)');
