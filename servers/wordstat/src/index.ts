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
 * Чистая логика (HTTP-слой, устройства, точная форма, валидация дат, кэш дерева) — wordstat.ts.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  accountParam,
  jsonResult,
  loadSharedEnv,
  registerAuthTools,
  resolveRegionIds,
  safeHandler,
  withToolDefaults,
} from '@seo-tools/shared';
import { z } from 'zod';
import { flattenRegions, type RegionNode } from './regions.js';
import { createRegionNamesCache, exactForm, hasOperators, resolveDevices, toNum, validateDynamicsDates, wordstatPost } from './wordstat.js';

loadSharedEnv();

// Регионы — единый справочник в shared (resolveRegionIds); полное дерево — wordstat_regions_tree

// Справочник id→название регионов: дерево большое и меняется редко — кешируем на сутки per-профиль.
// Дедупликация in-flight промиса внутри createRegionNamesCache: параллельные вызовы на холодном
// кэше дают ОДИН запрос getRegionsTree, а не несколько.
const regionNamesCaches = new Map<string, () => Promise<Map<string, string>>>();
function regionNames(account?: string): Promise<Map<string, string>> {
  const key = account ?? '';
  let cache = regionNamesCaches.get(key);
  if (!cache) {
    cache = createRegionNamesCache(async () => {
      const tree = await wordstatPost<{ regions?: RegionNode[] }>('getRegionsTree', {}, account);
      return flattenRegions(tree.regions);
    });
    regionNamesCaches.set(key, cache);
  }
  return cache();
}

interface TopResponse {
  totalCount: string;
  results?: Array<{ phrase: string; count: string }>;
  associations?: Array<{ phrase: string; count: string }>;
}

// withToolDefaults проставляет всем инструментам readOnlyHint/openWorldHint и title
const server = withToolDefaults(new McpServer({ name: 'wordstat', version: '1.8.0' }));

registerAuthTools(
  server,
  'wordstat',
  [
    { env: 'WORDSTAT_API_KEY', label: 'Api-Key сервисного аккаунта Yandex Cloud (scope yc.search-api.execute)' },
    { env: 'WORDSTAT_FOLDER_ID', label: 'ID каталога (folder) Yandex Cloud, где живёт сервисный аккаунт', secret: false },
  ],
  {
    help:
      'Wordstat API v2 бесплатен, заявок не требует. Один раз в Yandex Cloud (console.yandex.cloud): ' +
      '1) создать каталог (folder) или взять существующий — его ID → WORDSTAT_FOLDER_ID; ' +
      '2) создать сервисный аккаунт с ролью search-api.webSearch.user; ' +
      '3) для него выпустить API-ключ с областью действия yc.search-api.execute → WORDSTAT_API_KEY. ' +
      'Квоты: 10 запросов/сек, 100/час. Проверка — wordstat_frequency по любой фразе.',
  },
);

server.registerTool(
  'wordstat_frequency',
  {
    description:
      'Частотность фразы в Яндексе за последние 30 дней: широкая (freq_broad) и точная (freq_exact, «"!слово !слово"») ' +
      '+ уточняющие запросы (related, «левая колонка» Вордстата) и похожие (associations, «правая колонка», ≤20). ' +
      'related_truncated=true — related обрезан по relatedLimit (за ответом могли остаться строки, увеличь relatedLimit). ' +
      'Официальный API — бесплатный, 2 запроса к API на вызов (квота 100/час). region: «Москва»/«Россия»/id, можно несколько через запятую.',
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

    const related = mapRows(broad.results);
    return jsonResult({
      query: args.query,
      exact_form: exact,
      region: args.region ?? 'все регионы',
      device: args.device ?? 'all',
      period: 'последние 30 дней',
      freq_broad: toNum(broad.totalCount),
      freq_exact: toNum(exactRes.totalCount),
      related,
      // relatedLimit строк не гарантирует, что выдано всё: >= лимита = возможно обрезано API
      related_truncated: related.length >= args.relatedLimit,
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
      'monthly требует fromDate = 1-е число и toDate = последний день месяца, weekly — fromDate понедельник. ' +
      'Данные weekly/monthly с 2018 года, daily — последние 60 дней. Даты валидируются до запроса.',
    inputSchema: {
      query: z.string().min(1).max(400),
      period: z.enum(['daily', 'weekly', 'monthly']).default('monthly'),
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('YYYY-MM-DD'),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('YYYY-MM-DD'),
      region: z.string().optional().describe('Регион(ы): название или id Яндекса через запятую; пусто = все'),
      device: z.string().optional().describe('all | desktop | phone | tablet (можно через запятую)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    validateDynamicsDates(args.period, args.fromDate, args.toDate);
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
      'Распределение частотности фразы по регионам за 30 дней: { results: [{ region_id, region_name, count, share, affinityIndex }] }. ' +
      'affinityIndex > 100 — интерес выше среднего по стране. regionType: cities | regions | all. Имена регионов резолвятся из дерева (кеш). ' +
      'Первый вызов за сутки — 2 запроса к API (regions + дерево имён), далее 1.',
    inputSchema: {
      query: z.string().min(1).max(400),
      regionType: z.enum(['cities', 'regions', 'all']).default('regions'),
      device: z.string().optional().describe('all | desktop | phone | tablet (можно через запятую)'),
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

    // имена — «best effort»: их отсутствие не рушит частотность, но помечаем деградацию флагом
    let namesResolved = true;
    const [data, names] = await Promise.all([
      wordstatPost<{ results?: Array<{ region: string; count: string; share: number; affinityIndex: number }> }>(
        'regions',
        body,
        args.account,
      ),
      regionNames(args.account).catch(() => {
        namesResolved = false;
        return new Map<string, string>();
      }),
    ]);
    const all = (data.results ?? [])
      .map((r) => ({
        region_id: r.region,
        region_name: names.get(String(r.region)) ?? null,
        count: toNum(r.count),
        share: r.share ?? null,
        affinityIndex: r.affinityIndex ?? null,
      }))
      .sort((a, b) => b.count - a.count);
    const results = all.slice(0, args.limit);
    return jsonResult({
      query: args.query,
      regionType: args.regionType,
      total: all.length,
      truncated: all.length > results.length, // true = выдано не всё, увеличь limit
      region_names_resolved: namesResolved, // false = дерево имён не загрузилось, region_name=null
      results,
    });
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
