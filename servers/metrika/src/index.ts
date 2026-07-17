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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[metrika] MCP-сервер запущен (stdio)');
