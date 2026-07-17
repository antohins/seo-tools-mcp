#!/usr/bin/env node
/**
 * wordstat-mcp — официальный Wordstat API v2 (Yandex Cloud Search API) для SEO-пайплайна.
 * Бесплатный (Preview). Авторизация: Api-Key сервисного аккаунта Yandex Cloud
 * (env WORDSTAT_API_KEY + WORDSTAT_FOLDER_ID). Питает: A.4 (вершины), приоритизация ядра.
 *
 * Нюансы API: POST https://searchapi.api.cloud.yandex.net/v2/wordstat/*;
 * folderId обязателен в теле каждого запроса; count/totalCount приходят СТРОКАМИ;
 * операторы (!слово, "фраза", -минус) поддерживаются в topRequests/regions,
 * в dynamics — только при period=DAILY; данные topRequests = за последние 30 дней;
 * квоты: 10 rps и 100 запросов/час (429 при превышении).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadSharedEnv, requireEnv, fetchJson, jsonResult, safeHandler, registerAuthTools, accountParam, resolveRegionIds } from '@seo-tools/shared';

loadSharedEnv();

const BASE = 'https://searchapi.api.cloud.yandex.net/v2/wordstat';

// Регионы — единый справочник в shared (resolveRegionIds); полное дерево — wordstat_regions_tree

const DEVICE_MAP: Record<string, string> = {
  all: 'DEVICE_ALL',
  desktop: 'DEVICE_DESKTOP',
  phone: 'DEVICE_PHONE',
  tablet: 'DEVICE_TABLET',
};

function resolveDevices(device: string | undefined): string[] | undefined {
  if (!device || device === 'all') return undefined;
  return device.split(',').map((d) => {
    const v = DEVICE_MAP[d.trim().toLowerCase()];
    if (!v) throw new Error(`Неизвестное устройство «${d}» — допустимо: all, desktop, phone, tablet`);
    return v;
  });
}

async function wordstatPost<T = any>(path: string, body: Record<string, unknown>, account?: string): Promise<T> {
  const apiKey = requireEnv('WORDSTAT_API_KEY', account);
  const folderId = requireEnv('WORDSTAT_FOLDER_ID', account);
  return fetchJson<T>(`${BASE}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ folderId, ...body }),
    timeoutMs: 60_000,
  });
}

const toNum = (v: unknown): number => {
  const n = Number(v); // count/totalCount приходят строками (proto int64)
  return Number.isFinite(n) ? n : 0;
};

/**
 * true, если во фразе уже есть операторы Вордстата — тогда точную форму не строим сами.
 * ВАЖНО: дефис/минус и «+» — операторы только В НАЧАЛЕ слова (« -слово», «+на»);
 * дефис внутри слова («санкт-петербург») оператором НЕ является.
 */
const hasOperators = (q: string): boolean => /["\[\]()|]/.test(q) || /(^|\s)[!+-]\S/.test(q);

/** «купить квартиру» → «"!купить !квартиру"» (точная частотность как в веб-Вордстате). */
function exactForm(query: string): string {
  return `"${query.trim().split(/\s+/).map((w) => `!${w}`).join(' ')}"`;
}

interface TopResponse {
  totalCount: string;
  results?: Array<{ phrase: string; count: string }>;
  associations?: Array<{ phrase: string; count: string }>;
}

const server = new McpServer({ name: 'wordstat', version: '1.0.0' });

registerAuthTools(server, 'wordstat', [
  { env: 'WORDSTAT_API_KEY', label: 'Api-Key сервисного аккаунта Yandex Cloud (scope yc.search-api.execute)' },
  { env: 'WORDSTAT_FOLDER_ID', label: 'ID каталога (folder) Yandex Cloud, где живёт сервисный аккаунт', secret: false },
], {
  help:
    'Wordstat API v2 бесплатен, заявок не требует. Один раз в Yandex Cloud (console.yandex.cloud): ' +
    '1) создать каталог (folder) или взять существующий — его ID → WORDSTAT_FOLDER_ID; ' +
    '2) создать сервисный аккаунт с ролью search-api.webSearch.user; ' +
    '3) для него выпустить API-ключ с областью действия yc.search-api.execute → WORDSTAT_API_KEY. ' +
    'Квоты: 10 запросов/сек, 100/час. Проверка — wordstat_frequency по любой фразе.',
});

server.registerTool(
  'wordstat_frequency',
  {
    description:
      'Частотность фразы в Яндексе за последние 30 дней: широкая (freq_broad) и точная (freq_exact, «"!слово !слово"») ' +
      '+ уточняющие запросы (related, «левая колонка» Вордстата) и похожие (associations, «правая колонка», ≤20). ' +
      '2 запроса к API на вызов (квота 100/час). region: «Москва»/«Россия»/id, можно несколько через запятую.',
    inputSchema: {
      query: z.string().min(1).max(400),
      region: z.string().optional().describe('Регион(ы): название или id Яндекса через запятую; пусто = все'),
      device: z.string().optional().describe('all | desktop | phone | tablet (можно через запятую)'),
      relatedLimit: z.number().int().min(1).max(2000).default(100).describe('Сколько уточняющих запросов вернуть'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const regions = resolveRegionIds(args.region);
    const devices = resolveDevices(args.device);
    const common: Record<string, unknown> = {};
    if (regions) common.regions = regions;
    if (devices) common.devices = devices;

    const exact = hasOperators(args.query) ? args.query : exactForm(args.query);
    const [broad, exactRes] = await Promise.all([
      wordstatPost<TopResponse>('topRequests', { ...common, phrase: args.query, numPhrases: args.relatedLimit }, args.account),
      wordstatPost<TopResponse>('topRequests', { ...common, phrase: exact, numPhrases: 1 }, args.account),
    ]);

    const mapRows = (rows?: Array<{ phrase: string; count: string }>) =>
      (rows ?? []).map((r) => ({ phrase: r.phrase, freq_broad: toNum(r.count) }));

    return jsonResult({
      query: args.query,
      exact_form: exact,
      region: args.region ?? 'все регионы',
      device: args.device ?? 'all',
      period: 'последние 30 дней',
      freq_broad: toNum(broad.totalCount),
      freq_exact: toNum(exactRes.totalCount),
      related: mapRows(broad.results),
      associations: mapRows(broad.associations),
    });
  }),
);

server.registerTool(
  'wordstat_dynamics',
  {
    description:
      'Динамика частотности фразы: { results: [{ date, count, share }] }. ' +
      'ВАЖНО: операторы («!», кавычки) работают только при period=daily; ' +
      'monthly требует fromDate = 1-е число и toDate = последний день месяца, weekly — понедельник/воскресенье. ' +
      'Данные weekly/monthly с 2018 года, daily — последние 60 дней.',
    inputSchema: {
      query: z.string().min(1).max(400),
      period: z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
      fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
      toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD'),
      region: z.string().optional(),
      device: z.string().optional(),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const regions = resolveRegionIds(args.region);
    const devices = resolveDevices(args.device);
    const body: Record<string, unknown> = {
      phrase: args.query,
      period: `PERIOD_${args.period.toUpperCase()}`,
      fromDate: `${args.fromDate}T00:00:00Z`,
      toDate: `${args.toDate}T00:00:00Z`,
    };
    if (regions) body.regions = regions;
    if (devices) body.devices = devices;

    const data = await wordstatPost<{ results?: Array<{ date: string; count: string; share: number }> }>('dynamics', body, args.account);
    const results = (data.results ?? []).map((r) => ({
      date: r.date?.slice(0, 10) ?? '',
      count: toNum(r.count),
      share: r.share ?? null,
    }));
    return jsonResult({ query: args.query, period: args.period, results });
  }),
);

server.registerTool(
  'wordstat_regions',
  {
    description:
      'Распределение частотности фразы по регионам за 30 дней: { results: [{ region_id, count, share, affinityIndex }] }. ' +
      'affinityIndex > 100 — интерес выше среднего по стране. regionType: cities | regions | all.',
    inputSchema: {
      query: z.string().min(1).max(400),
      regionType: z.enum(['cities', 'regions', 'all']).default('regions'),
      device: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(50).describe('Топ-N регионов по count'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const devices = resolveDevices(args.device);
    const body: Record<string, unknown> = {
      phrase: args.query,
      region: `REGION_${args.regionType.toUpperCase()}`,
    };
    if (devices) body.devices = devices;

    const data = await wordstatPost<{ results?: Array<{ region: string; count: string; share: number; affinityIndex: number }> }>('regions', body, args.account);
    const results = (data.results ?? [])
      .map((r) => ({ region_id: r.region, count: toNum(r.count), share: r.share ?? null, affinityIndex: r.affinityIndex ?? null }))
      .sort((a, b) => b.count - a.count)
      .slice(0, args.limit);
    return jsonResult({ query: args.query, regionType: args.regionType, results });
  }),
);

server.registerTool(
  'wordstat_regions_tree',
  {
    description: 'Дерево всех регионов Вордстата (id + название) — для поиска id нестандартного региона.',
    inputSchema: {
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const data = await wordstatPost<{ regions?: unknown[] }>('getRegionsTree', {}, args.account);
    return jsonResult(data);
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[wordstat] MCP-сервер запущен (stdio)');
