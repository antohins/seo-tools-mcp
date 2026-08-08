#!/usr/bin/env node
/**
 * gsc-mcp — Google Search Console для SEO-пайплайна: Search Analytics (gsc_query),
 * URL Inspection (gsc_inspect_url), сайтмапы (gsc_list_sitemaps/gsc_get_sitemap).
 * Авторизация (любой из двух путей):
 *  1) OAuth пользователя (gsc_oauth_start/finish) — токен видит ВСЕ свойства,
 *     доступные Google-аккаунту, добавлять пользователя в каждое свойство не нужно;
 *  2) service account (GSC_SA_JSON) — для headless-кронов; добавляется в каждое
 *     свойство вручную.
 * Сама механика Google-авторизации (кеш токена, refresh-дедуп, JWT, 401/403,
 * loopback-приёмник, oauth_start/finish/save_sa_json) — общая, в @seo-tools/shared/google.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { accountParam, jsonResult, loadSharedEnv, registerAuthTools, safeHandler } from '@seo-tools/shared';
import { createGoogleAuth, registerGoogleOauthTools } from '@seo-tools/shared/google';
import { z } from 'zod';
import { buildQueryBody, forbidden403Hint, type GscRow, mapKeysToDimensions, resolveSite, validateDates } from './logic.js';
import { collectRows, type TruncatedBy } from './paginate.js';

loadSharedEnv();

const PAGE_SIZE = 25_000; // максимум GSC API за запрос
const QUERY_DEADLINE_MS = 5 * 60_000; // общий потолок на всю пагинацию одного gsc_query
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const OAUTH_PORT = Number(process.env.GSC_OAUTH_PORT || 8585); // реальный env процесса — ок
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}`;

// Авторизация Google — общая фабрика (кеш токена по профилю, дедуп refresh, JWT для
// сервис-аккаунта, 401-ретрай только для OAuth, 403 → доменная подсказка).
const auth = createGoogleAuth({
  toolPrefix: 'gsc',
  scope: SCOPE,
  refreshEnv: 'GSC_REFRESH_TOKEN',
  saJsonEnv: 'GSC_SA_JSON',
  apiName: 'Search Console API',
  noAuthHint: (account) =>
    `Нет авторизации GSC${account ? ` для аккаунта «${account}»` : ''}. ` +
    `Либо OAuth: gsc_oauth_start${account ? ` (account="${account}")` : ''} → ссылка → gsc_oauth_finish (токен видит все свойства аккаунта), ` +
    'либо сервис-аккаунт: gsc_save_sa_json / gsc_set_credentials (GSC_SA_JSON) + добавить его email в каждое свойство. ' +
    'Текущий статус ключей и инструкция — gsc_auth_status.',
  forbiddenHint: forbidden403Hint,
});
const resetAuthCaches = auth.resetCaches;
const gscFetch = auth.googleFetch;

interface QueryAllResult {
  rows: GscRow[];
  truncated: boolean;
  truncatedBy?: TruncatedBy;
  /** metadata.first_incomplete_date первого ответа (приходит при dataState=all): с какой даты данные ещё не финальные. */
  firstIncompleteDate: string | null;
}

async function queryAll(siteUrl: string, body: Record<string, unknown>, limit: number, account?: string): Promise<QueryAllResult> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  let firstIncompleteDate: string | null = null;
  // логика пагинации — в collectRows (тестируется отдельно); здесь только реальный fetch страницы
  const { rows, truncated, truncatedBy } = await collectRows<GscRow>(
    async (rowLimit, startRow) => {
      const page = await gscFetch<{ rows?: GscRow[]; metadata?: { first_incomplete_date?: string } }>(
        url,
        {
          method: 'POST',
          body: JSON.stringify({ ...body, rowLimit, startRow }),
          attempts: 2, // длинный таймаут × повтор × 401-ретрай × страницы иначе висит минутами
        },
        account,
        siteUrl,
      );
      if (startRow === 0) firstIncompleteDate = page.metadata?.first_incomplete_date ?? null;
      return page.rows ?? [];
    },
    limit,
    PAGE_SIZE,
    QUERY_DEADLINE_MS,
  );
  return { rows, truncated, truncatedBy, firstIncompleteDate };
}

const server = new McpServer({ name: 'gsc', version: '1.6.0' });

registerAuthTools(
  server,
  'gsc',
  [
    { env: 'GOOGLE_CLIENT_ID', label: 'OAuth client ID из Google Cloud (для пути OAuth)', secret: false, required: false },
    { env: 'GOOGLE_CLIENT_SECRET', label: 'OAuth client secret из Google Cloud', required: false },
    { env: 'GSC_REFRESH_TOKEN', label: 'Refresh-токен OAuth (получается через gsc_oauth_start/finish)', required: false },
    { env: 'GSC_SA_JSON', label: 'Путь к JSON-ключу сервис-аккаунта (альтернативный путь)', secret: false, required: false },
    { env: 'GSC_SITE_URL', label: 'Свойство GSC по умолчанию (sc-domain:example.com)', secret: false, required: false },
  ],
  {
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
  },
);

// OAuth-инструменты (gsc_oauth_start / gsc_oauth_finish / gsc_save_sa_json) — общие,
// из @seo-tools/shared/google: механика flow одинакова у всех Google-серверов,
// различаются только scope, env-ключи и доменные тексты.
registerGoogleOauthTools(server, {
  prefix: 'gsc',
  scope: SCOPE,
  refreshEnv: 'GSC_REFRESH_TOKEN',
  saJsonEnv: 'GSC_SA_JSON',
  port: OAUTH_PORT,
  portEnv: 'GSC_OAUTH_PORT',
  auth,
  accessSummary: 'доступ ко ВСЕМ свойствам GSC этого Google-аккаунта (добавлять пользователя в каждое свойство не нужно)',
  apiName: 'Google Search Console API',
  checkTool: 'gsc_list_sites',
  saNextHint: 'Добавь этот email в GSC → Настройки → Пользователи и права (права «Полный»), затем проверь gsc_list_sites.',
});

server.registerTool(
  'gsc_query',
  {
    description:
      'Search Analytics по свойству GSC (по умолчанию GSC_SITE_URL из конфига). ' +
      'Возвращает строки {query|page|device..., clicks, impressions, ctr, position} (ctr — доля 0..1). ' +
      'Даты — в часовом поясе GSC (Pacific Time, НЕ МСК); история ~16 месяцев; финальные данные отстают на ~2-3 дня ' +
      '(свежие — через dataState=all, тогда в ответе firstIncompleteDate — с какой даты данные ещё не финальные). ' +
      'Пагинация собирается автоматически до rowLimit; truncated=true — данные могли остаться ' +
      '(truncatedBy: limit — упёрлись в rowLimit, deadline — общий дедлайн пагинации 5 мин). ' +
      'page — точный URL страницы для фильтра (мерджится в ту же filter-группу, что и filters); dimensions — например ["query"], ["query","device"], ["page"]. ' +
      'filters — произвольные фильтры измерений (dimensionFilterGroups): между фильтрами — AND; contains/regex — только для query/page, ' +
      'для country/device/searchAppearance — только equals/notEquals. Примеры: все запросы со словом — {dimension: "query", operator: "contains", expression: "купить"}; ' +
      'раздел сайта — {dimension: "page", operator: "includingRegex", expression: "/blog/"}. ' +
      'aggregationType — агрегация данных: auto (дефолт), byProperty (по свойству; НЕ сочетается с фильтром/группировкой по page ' +
      'и с searchType discover/googleNews — API вернёт ошибку), byPage (по каноническому URL страницы).',
    inputSchema: {
      siteUrl: z
        .string()
        .optional()
        .describe('Свойство GSC, например sc-domain:example.com (по умолчанию GSC_SITE_URL из конфига); для URL-prefix — с завершающим /'),
      page: z.string().optional().describe('Точный URL страницы для фильтра, например https://example.com/page/'),
      filters: z
        .array(
          z.object({
            dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']).describe('Измерение фильтра'),
            operator: z
              .enum(['equals', 'notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'])
              .describe('Оператор (contains/notContains/regex — только для query и page)'),
            expression: z.string().min(1).describe('Значение фильтра (для regex — синтаксис RE2)'),
          }),
        )
        .max(25)
        .optional()
        .describe('Произвольные фильтры измерений (AND внутри группы), мержатся с page в одну группу (page + до 25 фильтров)'),
      aggregationType: z
        .enum(['auto', 'byProperty', 'byPage'])
        .optional()
        .describe('Агрегация данных: auto (дефолт, в запрос не шлётся) | byProperty | byPage'),
      startDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('YYYY-MM-DD'),
      endDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('YYYY-MM-DD'),
      dimensions: z.array(z.enum(['query', 'page', 'device', 'country', 'date', 'searchAppearance'])).default(['query']),
      searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).default('web'),
      dataState: z
        .enum(['final', 'all'])
        .default('final')
        .describe('final = только финальные данные; all — включая свежие/неполные (последние дни)'),
      rowLimit: z.number().int().min(1).max(200_000).default(5000).describe('Сколько строк собрать суммарно (пагинация автоматическая)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    validateDates(args.startDate, args.endDate);
    const siteUrl = resolveSite(args.siteUrl, args.account);
    const body = buildQueryBody(args);
    const { rows: raw, truncated, truncatedBy, firstIncompleteDate } = await queryAll(siteUrl, body, args.rowLimit, args.account);
    const rows = raw.map((r) => mapKeysToDimensions(r, args.dimensions));
    console.error(
      `[gsc] ${siteUrl} ${args.startDate}..${args.endDate} dims=${args.dimensions.join(',')} → ${rows.length} строк${
        truncated ? (truncatedBy === 'deadline' ? ' (обрезано по времени — дедлайн 5 мин)' : ' (обрезано по rowLimit)') : ''
      }`,
    );
    return jsonResult({
      siteUrl,
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: args.dimensions,
      rowCount: rows.length,
      truncated,
      truncatedBy: truncatedBy ?? null,
      ...(args.dataState === 'all' ? { firstIncompleteDate } : {}),
      rows,
    });
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

server.registerTool(
  'gsc_get_site',
  {
    description: 'Уровень доступа авторизации к конкретному свойству GSC (permissionLevel).',
    inputSchema: {
      siteUrl: z.string().optional().describe('Свойство GSC (по умолчанию GSC_SITE_URL); для URL-prefix — с завершающим /'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const siteUrl = resolveSite(args.siteUrl, args.account);
    const data = await gscFetch<Record<string, unknown>>(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`,
      {},
      args.account,
      siteUrl,
    );
    return jsonResult(data);
  }),
);

server.registerTool(
  'gsc_inspect_url',
  {
    description:
      'URL Inspection: индекс-статус конкретного URL в Google — verdict, coverageState, indexingState, ' +
      'robotsTxtState, время последнего обхода, canonical (Google vs заявленный), crawledAs, ссылки-источники, ' +
      'а также mobile usability и rich results. URL должен быть под указанным свойством GSC. ' +
      'Квота — порядка 2000 вызовов в день на свойство: не дёргать массово.',
    inputSchema: {
      url: z.string().describe('Полный URL для инспекции, например https://example.com/page/'),
      siteUrl: z.string().optional().describe('Свойство GSC (по умолчанию GSC_SITE_URL); для URL-prefix — с завершающим /'),
      languageCode: z.string().optional().describe('BCP-47 язык результата (по умолчанию en-US)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const siteUrl = resolveSite(args.siteUrl, args.account);
    const data = await gscFetch<{ inspectionResult?: Record<string, any> }>(
      'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
      { method: 'POST', body: JSON.stringify({ inspectionUrl: args.url, siteUrl, languageCode: args.languageCode }) },
      args.account,
      siteUrl,
    );
    const r = data.inspectionResult ?? {};
    const idx = r.indexStatusResult ?? {};
    const mob = r.mobileUsabilityResult;
    const rich = r.richResultsResult;
    return jsonResult({
      siteUrl,
      url: args.url,
      inspectionResultLink: r.inspectionResultLink ?? null,
      indexStatus: {
        verdict: idx.verdict ?? null,
        coverageState: idx.coverageState ?? null,
        robotsTxtState: idx.robotsTxtState ?? null,
        indexingState: idx.indexingState ?? null,
        lastCrawlTime: idx.lastCrawlTime ?? null,
        pageFetchState: idx.pageFetchState ?? null,
        crawledAs: idx.crawledAs ?? null,
        googleCanonical: idx.googleCanonical ?? null,
        userCanonical: idx.userCanonical ?? null,
        sitemap: idx.sitemap ?? [],
        referringUrls: idx.referringUrls ?? [],
      },
      mobileUsability: mob ? { verdict: mob.verdict ?? null, issues: mob.issues ?? [] } : null,
      richResults: rich ? { verdict: rich.verdict ?? null, detectedItems: rich.detectedItems ?? [] } : null,
      ampResult: r.ampResult ?? null,
    });
  }),
);

server.registerTool(
  'gsc_list_sitemaps',
  {
    description:
      'Список сайтмапов свойства GSC со статусом (path, отправлен/скачан, ошибки/предупреждения, содержимое по типам). ' +
      'sitemapIndex — опционально: перечислить сайтмапы внутри конкретного sitemap-индекса.',
    inputSchema: {
      siteUrl: z.string().optional().describe('Свойство GSC (по умолчанию GSC_SITE_URL); для URL-prefix — с завершающим /'),
      sitemapIndex: z.string().optional().describe('URL sitemap-индекса — вернуть вложенные в него сайтмапы'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const siteUrl = resolveSite(args.siteUrl, args.account);
    let url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`;
    if (args.sitemapIndex) url += `?sitemapIndex=${encodeURIComponent(args.sitemapIndex)}`;
    const data = await gscFetch<{ sitemap?: unknown[] }>(url, {}, args.account, siteUrl);
    return jsonResult({ siteUrl, count: (data.sitemap ?? []).length, sitemaps: data.sitemap ?? [] });
  }),
);

server.registerTool(
  'gsc_get_sitemap',
  {
    description: 'Детали одного сайтмапа свойства GSC (статус, ошибки/предупреждения, последний обход, содержимое по типам).',
    inputSchema: {
      feedpath: z.string().describe('Полный URL сайтмапа, например https://example.com/sitemap.xml'),
      siteUrl: z.string().optional().describe('Свойство GSC (по умолчанию GSC_SITE_URL); для URL-prefix — с завершающим /'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const siteUrl = resolveSite(args.siteUrl, args.account);
    const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(args.feedpath)}`;
    const data = await gscFetch<Record<string, unknown>>(url, {}, args.account, siteUrl);
    return jsonResult({ siteUrl, sitemap: data });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[gsc] MCP-сервер запущен (stdio)');
