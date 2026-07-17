#!/usr/bin/env node
/**
 * metrika-mcp — Яндекс.Метрика Stat API (read-only) для SEO-пайплайна.
 * Авторизация: env METRIKA_OAUTH_TOKEN (+ METRIKA_COUNTER_ID по умолчанию).
 * Питает: E.4 (NavBoost: dwell/bad-clicks), F (MONITOR).
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
import { landingFilter } from './filters.js';
import { collectAllPages, type StatResponse } from './paginate.js';
import { mapReportRows, shortKey } from './report.js';

loadSharedEnv();

const STAT_URL = 'https://api-metrika.yandex.net/stat/v1/data';
const MGMT_URL = 'https://api-metrika.yandex.net/management/v1';
const TOKEN_ENV = 'METRIKA_OAUTH_TOKEN';

function counterId(override?: number, account?: string): string {
  if (override) return String(override);
  const id = getConfig('METRIKA_COUNTER_ID', account);
  if (!id) {
    throw new Error(
      `Не указан счётчик Метрики${account ? ` для аккаунта «${account}»` : ''}: передай counterId или сохрани дефолт ` +
        `через metrika_set_credentials${account ? ` (account="${account}")` : ''}. Список счётчиков — metrika_counters.`,
    );
  }
  return id;
}

// кеш целей счётчика: цели меняются редко, а goals-запрос шёл перед КАЖДЫМ landing_behavior
const goalsCache = new Map<string, { ts: number; goals: Array<{ id: number; name: string }> }>();
const GOALS_TTL_MS = 10 * 60_000;

async function statQuery(params: Record<string, string | number | undefined>, account?: string): Promise<StatResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  return yandexFetchJson<StatResponse>(TOKEN_ENV, `${STAT_URL}?${qs}`, {}, account);
}

/** Тонкая обёртка: постраничный сбор (логика — в collectAllPages, тестируется отдельно). */
function statQueryAll(params: Record<string, string | number | undefined>, maxRows: number, account?: string): Promise<StatResponse> {
  return collectAllPages((offset, limit) => statQuery({ ...params, limit, offset }, account), maxRows);
}

/** GET Stat API /bytime (динамика метрик по времени). */
async function statBytime(params: Record<string, string | number | undefined>, account?: string): Promise<BytimeResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  return yandexFetchJson<BytimeResponse>(TOKEN_ENV, `${STAT_URL}/bytime?${qs}`, {}, account);
}

interface BytimeResponse {
  data: Array<{ dimensions: Array<{ name: string }>; metrics: number[][] }>;
  time_intervals?: string[][];
  totals?: number[][];
  sampled?: boolean;
}

// Базовые метрики визитов для курируемых отчётов
const SESSION_METRICS = ['ym:s:visits', 'ym:s:users', 'ym:s:bounceRate', 'ym:s:pageDepth', 'ym:s:avgVisitDurationSeconds'];

/** Диапазон дат YYYY-MM-DD: заданный или последние `days` дней. */
function metrikaDates(date1: string | undefined, date2: string | undefined, days: number): { date1: string; date2: string } {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { date1: date1 ?? iso(Date.now() - days * 864e5), date2: date2 ?? iso(Date.now()) };
}

/** Универсальный отчёт Stat API /data → строки + totals + флаг сэмплирования. */
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
  return {
    rows: mapReportRows(res, o.dimensions, o.metrics),
    totals: res.totals ?? null,
    total_rows: res.total_rows ?? null,
    sampled: res.sampled ?? false,
  };
}

const counterIdParam = z.number().int().optional().describe('Номер счётчика (по умолчанию METRIKA_COUNTER_ID)');
const date1Param = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('YYYY-MM-DD (по умолчанию 30 дней назад)');
const date2Param = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .describe('YYYY-MM-DD (по умолчанию сегодня)');

const server = new McpServer({ name: 'metrika', version: '1.0.0' });

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
    description: 'Список счётчиков Метрики, доступных токену — для проверки доступа и выбора METRIKA_COUNTER_ID.',
    inputSchema: {
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const data = await yandexFetchJson<{ counters?: Array<{ id: number; name: string; site2?: { site: string } }> }>(
      TOKEN_ENV,
      `${MGMT_URL}/counters`,
      {},
      args.account,
    );
    return jsonResult({
      account: args.account ?? null,
      counters: (data.counters ?? []).map((c) => ({ id: c.id, name: c.name, site: c.site2?.site ?? null })),
    });
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
  counterId: z.number().int().optional().describe('Номер счётчика (по умолчанию METRIKA_COUNTER_ID)'),
  account: accountParam,
};

server.registerTool(
  'metrika_landing_behavior',
  {
    description:
      'Поведение на странице входа (E.4 NavBoost): visits, bounceRate, pageDepth, avgVisitDurationSeconds + достижения целей. ' +
      'source=organic фильтрует органический трафик (ym:s:lastTrafficSource). ' +
      'goalIds — список ID целей для goalReaches (без него цели подтягиваются автоматически из счётчика).',
    inputSchema: {
      ...commonInput,
      source: z.enum(['organic', 'all']).default('organic'),
      searchEngine: z.enum(['all', 'yandex', 'google']).default('all').describe('Дополнительно сузить до конкретного поисковика'),
      goalIds: z.array(z.number().int()).optional(),
    },
  },
  safeHandler(async (args) => {
    const id = counterId(args.counterId, args.account);

    const filters: string[] = [landingFilter(args.landingPage)];
    if (args.source === 'organic') filters.push(`ym:s:lastTrafficSource=='organic'`);
    if (args.searchEngine !== 'all') filters.push(`ym:s:lastSearchEngineRoot=='${args.searchEngine}'`);

    // цели: либо явные, либо все из счётчика
    let goalIds = args.goalIds ?? [];
    const goalNames = new Map<number, string>();
    if (!goalIds.length) {
      try {
        const cached = goalsCache.get(id);
        let goals = cached && Date.now() - cached.ts < GOALS_TTL_MS ? cached.goals : null;
        if (!goals) {
          const resp = await yandexFetchJson<{ goals?: Array<{ id: number; name: string }> }>(
            TOKEN_ENV,
            `${MGMT_URL}/counter/${id}/goals`,
            {},
            args.account,
          );
          goals = resp.goals ?? [];
          goalsCache.set(id, { ts: Date.now(), goals });
        }
        for (const g of goals) {
          goalIds.push(g.id);
          goalNames.set(g.id, g.name);
        }
      } catch (err) {
        console.error(`[metrika] не смог получить список целей: ${String(err)}`);
      }
    }
    goalIds = goalIds.slice(0, 10); // ограничение на число метрик в одном запросе

    const baseMetrics = ['ym:s:visits', 'ym:s:users', 'ym:s:bounceRate', 'ym:s:pageDepth', 'ym:s:avgVisitDurationSeconds'];
    const goalMetrics = goalIds.map((g) => `ym:s:goal${g}reaches`);

    const res = await statQuery(
      {
        ids: id,
        date1: args.startDate,
        date2: args.endDate,
        metrics: [...baseMetrics, ...goalMetrics].join(','),
        filters: filters.join(' AND '),
        accuracy: 'full',
      },
      args.account,
    );

    const totals = res.totals ?? res.data[0]?.metrics ?? [];
    const goalReaches: Record<string, number> = {};
    goalIds.forEach((g, i) => {
      const label = goalNames.get(g) ? `${goalNames.get(g)} (#${g})` : `goal_${g}`;
      goalReaches[label] = totals[baseMetrics.length + i] ?? 0;
    });

    return jsonResult({
      landingPage: args.landingPage,
      startDate: args.startDate,
      endDate: args.endDate,
      source: args.source,
      visits: totals[0] ?? 0,
      users: totals[1] ?? 0,
      bounceRate: (totals[2] ?? 0) / 100, // Метрика отдаёт проценты — нормализуем в долю
      pageDepth: totals[3] ?? 0,
      avgVisitDurationSeconds: totals[4] ?? 0,
      goalReaches,
      sampled: res.sampled ?? false,
    });
  }),
);

server.registerTool(
  'metrika_search_phrases',
  {
    description:
      'Поисковые фразы (в основном Яндекс — Google шифрует) c поведением по странице входа: ' +
      '{ rows: [{ phrase, visits, bounceRate, avgVisitDurationSeconds }] }.',
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
    const id = counterId(args.counterId, args.account);
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
      bounceRate: (r.metrics[1] ?? 0) / 100,
      pageDepth: r.metrics[2] ?? 0,
      avgVisitDurationSeconds: r.metrics[3] ?? 0,
    }));
    return jsonResult({ landingPage: args.landingPage ?? null, rowCount: rows.length, totalRows: res.total_rows ?? rows.length, rows });
  }),
);

server.registerTool(
  'metrika_top_landings',
  {
    description:
      'Топ страниц входа из органики за период (F MONITOR): { rows: [{ landing, visits, bounceRate, avgVisitDurationSeconds }] }.',
    inputSchema: {
      startDate: commonInput.startDate,
      endDate: commonInput.endDate,
      counterId: commonInput.counterId,
      account: commonInput.account,
      limit: z.number().int().min(1).max(10_000).default(200),
    },
  },
  safeHandler(async (args) => {
    const id = counterId(args.counterId, args.account);
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
      bounceRate: (r.metrics[1] ?? 0) / 100,
      pageDepth: r.metrics[2] ?? 0,
      avgVisitDurationSeconds: r.metrics[3] ?? 0,
    }));
    return jsonResult({ rowCount: rows.length, rows });
  }),
);

server.registerTool(
  'metrika_report',
  {
    description:
      'Произвольный отчёт Stat API: любые измерения × метрики Метрики. Даёт полный доступ к отчётам. ' +
      'dimensions/metrics — имена вида ym:s:<name> (визиты) или ym:pv:<name> (просмотры), напр. ' +
      'ym:s:lastTrafficSource, ym:s:deviceCategory, ym:s:regionCity; метрики ym:s:visits, ym:s:users, ym:s:bounceRate. ' +
      "filters — выражение Метрики (ym:s:lastTrafficSource=='organic'). Ключи в ответе — короткие (без ym:ns:).",
    inputSchema: {
      metrics: z.array(z.string()).min(1).describe('Метрики, напр. ["ym:s:visits","ym:s:users","ym:s:bounceRate"]'),
      dimensions: z.array(z.string()).default([]).describe('Измерения (можно пусто — тогда только totals)'),
      date1: date1Param,
      date2: date2Param,
      filters: z.string().optional().describe("Выражение фильтра Метрики, напр. ym:s:lastTrafficSource=='organic'"),
      sort: z.string().optional().describe('Сортировка, напр. -ym:s:visits'),
      limit: z.number().int().min(1).max(50_000).default(1000),
      accuracy: z.string().default('full').describe("full | 'auto' | доля выборки 0..1 (напр. 0.1)"),
      counterId: counterIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const id = counterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
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
      'group: day | week | month | hour. Возвращает { time_intervals, series: [{ …измерения, metrics }] }.',
    inputSchema: {
      metrics: z.array(z.string()).min(1).describe('Метрики, напр. ["ym:s:visits","ym:s:users"]'),
      dimensions: z.array(z.string()).default([]).describe('Измерения (напр. ["ym:s:lastTrafficSource"]) — отдельный ряд на значение'),
      group: z.enum(['day', 'week', 'month', 'hour']).default('day'),
      date1: date1Param,
      date2: date2Param,
      filters: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      counterId: counterIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const id = counterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
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
    const series = (res.data ?? []).map((r) => {
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
      sampled: res.sampled ?? false,
      series,
    });
  }),
);

server.registerTool(
  'metrika_traffic_sources',
  {
    description:
      'Источники трафика: визиты/пользователи/отказы/глубина/длительность по ym:s:lastTrafficSource (organic/direct/ad/referral/social/…).',
    inputSchema: {
      date1: date1Param,
      date2: date2Param,
      limit: z.number().int().min(1).max(1000).default(20),
      counterId: counterIdParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const id = counterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
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
    description: 'География визитов: распределение по странам/регионам/городам. level: country | region | city.',
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
    const id = counterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
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
    description: 'Технологии визитов: распределение по устройствам/ОС/браузерам. by: device | os | browser.',
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
    const id = counterId(args.counterId, args.account);
    const { date1, date2 } = metrikaDates(args.date1, args.date2, 30);
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
    const id = counterId(args.counterId, args.account);
    const data = await yandexFetchJson<{ goals?: Array<{ id: number; name: string; type: string }> }>(
      TOKEN_ENV,
      `${MGMT_URL}/counter/${id}/goals`,
      {},
      args.account,
    );
    return jsonResult({ counter: id, goals: (data.goals ?? []).map((g) => ({ id: g.id, name: g.name, type: g.type })) });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[metrika] MCP-сервер запущен (stdio)');
