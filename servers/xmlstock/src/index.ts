#!/usr/bin/env node
/**
 * xmlstock-mcp — SERP Google/Yandex через XMLStock (xmlstock.com) для SEO-пайплайна.
 * Авторизация: env XMLSTOCK_USER, XMLSTOCK_KEY. Сервис ПЛАТНЫЙ за запрос —
 * число вызовов и оценка расхода логируются в stderr.
 * Питает: BASELINE 2.1/2.2, A.3, A.9, A.10.
 *
 * Нюансы API: подсветки — hlword=1 (вложенный тег <hlword>, БЕЗ CDATA);
 * PAA + related searches — related=1 (PAA только у Google);
 * страницы с 0 у всех движков; у live-движков глубина только пагинацией (groupby мёртв, всегда 10);
 * lr принимает id регионов Яндекса и для Google (авто-маппинг на стороне XMLStock);
 * ошибки приходят HTTP 200 с XML <error code>: 20-25/101/110/111/500 ретраить, 55 rate-limit,
 * 15 = пустая выдача (деньги списаны), 31/42 — фатальные (авторизация), 200 — фатальная.
 * includeSimilar → filter=0 (стандартная семантика Google «показать omitted results»).
 * Третий движок yandex_xml — официальный Яндекс XML (эндпоинт /yandex/xml/, лайв 2026-08):
 * groupby до 100 РАБОТАЕТ (до 100 результатов за 1 платный запрос), hlword-подсветки нативно
 * (title и passages), found и found-docs — РАЗНЫЕ счётчики (не путать), filter — семейный
 * фильтр strict/moderate/none (корректный дом для safeSearch), sortby rlv/tm, maxpassages 1-5;
 * SERP-фичей/packs нет — чистая органика; тариф дороже (от 24 ₽/1000) — отдельный счётчик
 * (XMLSTOCK_YANDEX_XML_PRICE_PER_CALL).
 * Wordstat у XMLStock ЕСТЬ (эндпоинт /wordstat/json/, официальный Wordstat API v2): tools
 * xmlstock_wordstat / _dynamics / _regions / _regions_tree — тем же ключом XMLSTOCK, без Yandex Cloud.
 * HTTP-слой SERP и хелперы выдачи — в ./serp.js (там же ретраи, учёт расхода, verticalCommon);
 * HTTP-слой Wordstat (wordstatGet), даты и кэш имён регионов — в ./wordstat.js.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  accountParam,
  fetchJson,
  getConfig,
  HttpError,
  jsonResult,
  loadSharedEnv,
  registerAuthTools,
  requireEnv,
  safeHandler,
} from '@seo-tools/shared';
import { z } from 'zod';
import {
  collectSerp,
  collectVertical,
  GOOGLE_URL,
  resolveLr,
  type SerpCollection,
  verticalCommon,
  YANDEX_URL,
  YANDEX_XML_URL,
  yandexXmlCommon,
  yandexXmlCost,
} from './serp.js';
import { parseImages, parseNews, parseVideo } from './verticals.js';
import {
  createWsRegionNames,
  flattenRegionsTree,
  parseHistory,
  parseRegions,
  parseWords,
  validateWsDateOrder,
  wordstatGet,
  wsDate,
} from './wordstat.js';

loadSharedEnv();

const BALANCE_URL = 'https://xmlstock.com/api/?do=balance';

// Домены-агрегаторы, исключаемые флагом excludeAggregators (переопределяются env-ом,
// читаются лениво — set_credentials применяется без перезапуска)
const DEFAULT_AGGREGATORS = 'avito.ru,cian.ru,domclick.ru,yandex.ru,m2.ru,youla.ru';
const aggregators = (): string[] =>
  (getConfig('XMLSTOCK_EXCLUDE_DOMAINS') || DEFAULT_AGGREGATORS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const server = new McpServer({ name: 'xmlstock', version: '1.7.0' });

registerAuthTools(
  server,
  'xmlstock',
  [
    { env: 'XMLSTOCK_USER', label: 'ID пользователя XMLStock (личный кабинет xmlstock.com)', secret: false },
    { env: 'XMLSTOCK_KEY', label: 'API-ключ XMLStock (личный кабинет xmlstock.com)' },
    { env: 'XMLSTOCK_EXCLUDE_DOMAINS', label: 'Домены-агрегаторы для excludeAggregators, через запятую', required: false, secret: false },
  ],
  {
    help:
      '1) Регистрация на https://xmlstock.com → личный кабинет. ' +
      '2) Пополнить баланс (Google XML от 12 ₽/1000, Яндекс Live от 12 ₽/1000, официальный Яндекс XML от 24 ₽/1000, Wordstat ~19 ₽/1000). ' +
      '3) Взять ID пользователя и API-ключ из кабинета. Проверка после сохранения — xmlstock_balance.',
  },
);

// Один регион: SERP/вертикали XMLStock принимают единственный lr (список не поддерживается)
const serpRegionParam = z
  .string()
  .default('Москва')
  .describe('«Москва»/«Россия»/213/225 — ОДИН регион (название или id Яндекса), XMLStock маппит и на Google');

server.registerTool(
  'xmlstock_serp',
  {
    description:
      'Слепок выдачи Google/Yandex через XMLStock (ПЛАТНО за запрос). ' +
      'Возвращает { found, truncated (true = выдача кончилась раньше запрошенного depth), count, ' +
      'results: [{ position, url, title, snippet, text_bolds (подсветки hlword) }], ' +
      'serp_features: { featured_snippet, paa (только Google), related, sitelinks_top1, packs } }. ' +
      'Пустая выдача (код 15) ТАРИФИЦИРУЕТСЯ и помечается { results: [], empty: true, note }. ' +
      'depth>10 добирается пагинацией (каждая страница — отдельный платный запрос; у yandex_xml — до 100/страница). ' +
      'region: ОДИН регион (название или числовой id Яндекса) — работает для ВСЕХ движков. ' +
      'ОГРАНИЧЕНИЕ ИСТОЧНИКА: device=mobile отдаёт только позиции и сниппеты — без hlword/PAA/related; ' +
      'подсветки и SERP-фичи снимать с desktop. ' +
      'engine=yandex_xml — ОФИЦИАЛЬНЫЙ Яндекс XML (легальный API, тариф дороже: от 24 ₽/1000): ' +
      'groupby до 100 работает — до 100 результатов за ОДИН платный запрос (depth до 1000), ' +
      'hlword-подсветки на любых устройствах, статистика «найдено»: found (по запросу), ' +
      'found_docs (документов), found_human (строкой); в results доп. поля id/modtime/saved_copy_url/is_local. ' +
      'Отличие от yandex (live): SERP-фичей/packs нет — чистая органика; device/searchDomain/lang/l10n/period/' +
      'exactQuery/includeAds/includeSimilar не применимы; safeSearch маппится в filter (strict/moderate/none).',
    inputSchema: {
      query: z.string().min(1),
      engine: z.enum(['google', 'yandex', 'yandex_xml']).default('google'),
      device: z.enum(['desktop', 'mobile']).default('desktop'),
      region: serpRegionParam,
      depth: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(10)
        .describe('Сколько органических позиций собрать: google/yandex — до 30 (10/страница), yandex_xml — до 1000 (100/страница)'),
      excludeAggregators: z
        .boolean()
        .default(false)
        .describe(
          'Исключить домены-агрегаторы из органики (список — XMLSTOCK_EXCLUDE_DOMAINS, дефолт: avito/cian/domclick/yandex/m2/youla)',
        ),
      includeAds: z
        .boolean()
        .default(false)
        .describe('Добавить рекламные блоки (ads=1): реклама включается в ответ API и отражается строками в packs, отдельной секции нет'),
      searchDomain: z
        .string()
        .regex(/^[a-z]{2,3}(\.[a-z]{2,3})?$/)
        .optional()
        .describe('Доменная зона: google — ru/com/de..., yandex — ru/by/kz/com.tr (по умолчанию ru)'),
      lang: z
        .string()
        .regex(/^[a-z]{2}(-[a-zA-Z]{2,4})?$/)
        .optional()
        .describe('Google hl (язык интерфейса), Yandex lang'),
      period: z.string().optional().describe('Google tbs (qdr:m, qdr:y...) / Yandex within (77=сутки, 1=2 недели, 2=месяц)'),
      exactQuery: z.boolean().default(false).describe('Не исправлять запрос (nfpr=1 / noreask=1)'),
      safeSearch: z
        .enum(['moderate', 'strict', 'off'])
        .default('moderate')
        .describe(
          'Безопасный поиск: Google — moderate = дефолт Google (размытие, параметр в API НЕ шлётся), strict = фильтр (safe=on), ' +
            'off = выкл (safe=off); Yandex и yandex_xml — семейный фильтр filter (moderate/strict/none)',
        ),
      includeSimilar: z.boolean().default(false).describe('Google: показать скрытые похожие результаты (filter=0)'),
      sortby: z.enum(['relevance', 'date']).default('relevance').describe('Yandex/yandex_xml: сортировка выдачи (rlv / tm — по дате)'),
      maxpassages: z.number().int().min(1).max(5).optional().describe('Yandex/yandex_xml: сколько пассажей-сниппетов на документ (1–5)'),
      l10n: z.enum(['ru', 'uk', 'be', 'kk', 'tr', 'en']).optional().describe('Yandex: язык уведомлений'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const isGoogle = args.engine === 'google';
    const isYandexXml = args.engine === 'yandex_xml';
    // лимит depth до платного запроса: live-движки — 10 результатов/страница (макс. 30),
    // официальный Яндекс XML — groupby до 100 (макс. 1000)
    if (!isYandexXml && args.depth > 30) {
      throw new Error(
        `depth=${args.depth} доступен только для engine=yandex_xml (100 результатов за запрос); для google/yandex максимум 30`,
      );
    }
    const base = isGoogle ? GOOGLE_URL : isYandexXml ? YANDEX_XML_URL : YANDEX_URL;

    let collected: SerpCollection;
    if (isYandexXml) {
      // официальный Яндекс XML: hlword нативно, device/domain/ads/related не применимы,
      // groupby=min(depth,100) — одна страница до 100 результатов за 1 платный запрос
      const common = yandexXmlCommon(args);
      collected = await collectSerp(base, common, args.depth, args.account, { groupby: Math.min(args.depth, 100), cost: yandexXmlCost });
    } else {
      const common: Record<string, string | number | undefined> = {
        query: args.query,
        device: args.device,
        hlword: 1, // подсветки <hlword> — критичны для блока A
        related: 1, // PAA (google) + related searches
        domain: args.searchDomain ?? 'ru',
      };
      const lr = resolveLr(args.region);
      if (lr !== undefined) common.lr = lr;
      if (args.includeAds) common.ads = 1;
      if (isGoogle) {
        if (args.lang) common.hl = args.lang;
        if (args.period) common.tbs = args.period;
        if (args.exactQuery) common.nfpr = 1;
        if (args.safeSearch === 'strict') common.safe = 'on';
        else if (args.safeSearch === 'off') common.safe = 'off';
        // filter=0 — стандартная семантика Google «показать omitted/similar results» (подтверждено лайвом)
        if (args.includeSimilar) common.filter = 0;
      } else {
        if (args.lang) common.lang = args.lang;
        if (args.period) common.within = args.period;
        if (args.exactQuery) common.noreask = 1;
        // Yandex family filter: moderate (дефолт) / strict / none
        common.filter = args.safeSearch === 'off' ? 'none' : args.safeSearch;
        if (args.sortby === 'date') common.sortby = 'tm';
        if (args.maxpassages) common.maxpassages = args.maxpassages;
        if (args.l10n) common.l10n = args.l10n;
      }
      collected = await collectSerp(base, common, args.depth, args.account);
    }

    let results = collected.results;
    if (args.excludeAggregators) {
      const aggs = aggregators();
      results = results.filter((r) => !aggs.some((a) => r.domain === a || r.domain.endsWith(`.${a}`)));
      results.forEach((r, i) => {
        r.position = i + 1;
      });
    }

    return jsonResult({
      query: args.query,
      engine: args.engine,
      // device к yandex_xml не применяется — не эхим, чтобы не вводить в заблуждение
      ...(isYandexXml ? {} : { device: args.device }),
      region: args.region,
      found: collected.found,
      // статистика «найдено» официального Яндекс XML: found_docs (документов) ≠ found (по запросу)
      ...(isYandexXml ? { found_docs: collected.foundDocs, found_human: collected.foundHuman } : {}),
      truncated: collected.truncated,
      // код 15 — пустая выдача: деньги списаны, явно помечаем, чтобы не путать с «нет данных»
      ...(collected.empty ? { empty: true, note: 'пустая выдача (код 15), запрос тарифицирован' } : {}),
      count: results.length,
      results,
      // у yandex_xml SERP-фичей/packs нет — чистая органика, поле не отдаём
      ...(isYandexXml
        ? {}
        : {
            serp_features: {
              ...(collected.features ?? { featured_snippet: null, paa: [], related: [] }),
              sitelinks_top1: collected.sitelinksTop1,
              packs: collected.packs,
            },
          }),
    });
  }),
);

const verticalInput = {
  query: z.string().min(1),
  region: serpRegionParam,
  depth: z.number().int().min(1).max(50).default(20).describe('Сколько результатов собрать (пагинация, каждая страница — платный запрос)'),
  device: z.enum(['desktop', 'mobile']).default('desktop'),
  searchDomain: z
    .string()
    .regex(/^[a-z]{2,3}(\.[a-z]{2,3})?$/)
    .optional()
    .describe('Доменная зона Google (ru/com/de...), по умолчанию ru'),
  safeSearch: z
    .enum(['moderate', 'strict', 'off'])
    .default('moderate')
    .describe('Безопасный поиск: moderate = дефолт Google (размытие, в API НЕ шлётся), strict = safe=on, off = safe=off'),
  account: accountParam,
};

server.registerTool(
  'xmlstock_images',
  {
    description:
      'Поиск по картинкам Google через XMLStock (ПЛАТНО за запрос). ' +
      'Возвращает { position, url (страница-источник), imageUrl (сама картинка), title }. ' +
      'truncated: true = выдача кончилась раньше запрошенного depth.',
    inputSchema: verticalInput,
  },
  safeHandler(async (args) => {
    const common = { ...verticalCommon(args), tbm: 'images' };
    const { results, found, empty, truncated } = await collectVertical(common, args.depth, parseImages, args.account);
    return jsonResult({
      query: args.query,
      tbm: 'images',
      region: args.region,
      found,
      truncated,
      ...(empty ? { empty: true, note: 'пустая выдача (код 15), запрос тарифицирован' } : {}),
      count: results.length,
      results,
    });
  }),
);

server.registerTool(
  'xmlstock_news',
  {
    description:
      'Поиск по новостям Google через XMLStock (ПЛАТНО за запрос). ' +
      'Возвращает { position, url, title, source (издание), date (часто относительная), snippet }. ' +
      'truncated: true = выдача кончилась раньше запрошенного depth.',
    inputSchema: verticalInput,
  },
  safeHandler(async (args) => {
    const common = { ...verticalCommon(args), tbm: 'news' };
    const { results, found, empty, truncated } = await collectVertical(common, args.depth, parseNews, args.account);
    return jsonResult({
      query: args.query,
      tbm: 'news',
      region: args.region,
      found,
      truncated,
      ...(empty ? { empty: true, note: 'пустая выдача (код 15), запрос тарифицирован' } : {}),
      count: results.length,
      results,
    });
  }),
);

server.registerTool(
  'xmlstock_video',
  {
    description:
      'Поиск по видео Google через XMLStock (ПЛАТНО за запрос). ' +
      'Возвращает { position, url, title, thumbnail, host (YouTube...), channel, duration, snippet }. ' +
      'truncated: true = выдача кончилась раньше запрошенного depth.',
    inputSchema: verticalInput,
  },
  safeHandler(async (args) => {
    const common = { ...verticalCommon(args), tbm: 'video' };
    const { results, found, empty, truncated } = await collectVertical(common, args.depth, parseVideo, args.account);
    return jsonResult({
      query: args.query,
      tbm: 'video',
      region: args.region,
      found,
      truncated,
      ...(empty ? { empty: true, note: 'пустая выдача (код 15), запрос тарифицирован' } : {}),
      count: results.length,
      results,
    });
  }),
);

server.registerTool(
  'xmlstock_balance',
  {
    description: 'Баланс и дневной расход аккаунта XMLStock (бесплатный сервисный вызов). Заодно проверка ключей.',
    inputSchema: {
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const user = requireEnv('XMLSTOCK_USER', args.account);
    const key = requireEnv('XMLSTOCK_KEY', args.account);
    const url = `${BALANCE_URL}&user=${encodeURIComponent(user)}&key=${encodeURIComponent(key)}`;
    let data: Record<string, unknown>;
    try {
      data = await fetchJson<Record<string, unknown>>(url);
    } catch (err) {
      if (err instanceof HttpError) throw err; // 5xx/сеть — транзиент с понятным HTTP-статусом
      // не-JSON ответ (обычно HTML при неверных кредах) — адресуем на ключи
      throw new Error(
        'XMLStock не вернул JSON с балансом — вероятно неверные XMLSTOCK_USER/XMLSTOCK_KEY. Проверьте ключи (xmlstock_set_credentials).',
      );
    }
    // Ругаемся только на явную ошибку в теле или пустой объект; ответ иной валидной формы отдаём как есть.
    const isObj = data !== null && typeof data === 'object' && !Array.isArray(data);
    const errText = isObj ? (data.error ?? data.Error) : undefined;
    if (errText !== undefined) {
      throw new Error(`XMLStock вернул ошибку (${String(errText)}) — проверьте XMLSTOCK_USER/XMLSTOCK_KEY (xmlstock_set_credentials).`);
    }
    if (isObj && Object.keys(data).length === 0) {
      throw new Error('XMLStock вернул пустой ответ — вероятно неверные XMLSTOCK_USER/XMLSTOCK_KEY (xmlstock_set_credentials).');
    }
    return jsonResult(data);
  }),
);

// ── XMLStock Wordstat API (эндпоинт /wordstat/json/, JSON; тот же ключ XMLSTOCK, что и для SERP) ──
// HTTP-слой (wordstatGet), даты (wsDate) и валидация — в ./wordstat.js

// Кэш дерева регионов (id→имя) на аккаунт, TTL 24ч — обогащаем ответ regions именами.
const wsRegionNames = createWsRegionNames((account) => wordstatGet('regionsTree', {}, account));

const wsRegionParam = z.string().optional().describe('Регион: «Москва»/«спб»/213 — id/название Яндекса; без него — вся Россия');

server.registerTool(
  'xmlstock_wordstat',
  {
    description:
      'Частотность и топ запросов Яндекс Wordstat через XMLStock (ПЛАТНО за запрос, ~19₽/1K). ' +
      'Возвращает { totalCount, results: [{ phrase, count }] (топ по фразе), associations: [{ phrase, count }] (похожие) }. ' +
      'Операторы Wordstat в query: "…" (точная), ! (форма слова), + (стоп-слово), - (минус), [ ] (порядок), | (или).',
    inputSchema: {
      query: z.string().min(1),
      region: wsRegionParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const params: Record<string, string | number | undefined> = { query: args.query };
    if (args.region) {
      const id = resolveLr(args.region);
      if (id !== undefined) params.regions = id;
    }
    const json = await wordstatGet('words', params, args.account);
    return jsonResult({ query: args.query, region: args.region ?? 'Россия', ...parseWords(json) });
  }),
);

server.registerTool(
  'xmlstock_wordstat_dynamics',
  {
    description:
      'Динамика частотности фразы по времени (Яндекс Wordstat через XMLStock, ПЛАТНО за запрос). ' +
      'period: day/week/month. from/to — YYYY-MM-DD (для month период автоматически растягивается на целые месяцы). ' +
      'Возвращает [{ date, count, share }].',
    inputSchema: {
      query: z.string().min(1),
      period: z.enum(['day', 'week', 'month']).default('month'),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Начало периода, YYYY-MM-DD'),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Конец периода, YYYY-MM-DD'),
      region: wsRegionParam,
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    validateWsDateOrder(args.from, args.to); // отсекаем перевёрнутый диапазон ДО платного запроса
    const month = args.period === 'month';
    const params: Record<string, string | number | undefined> = {
      query: args.query,
      period: args.period,
      start: wsDate(args.from, { startOfMonth: month }),
      end: wsDate(args.to, { endOfMonth: month }),
    };
    if (args.region) {
      const id = resolveLr(args.region);
      if (id !== undefined) params.regions = id;
    }
    const json = await wordstatGet('history', params, args.account);
    return jsonResult({ query: args.query, period: args.period, results: parseHistory(json) });
  }),
);

server.registerTool(
  'xmlstock_wordstat_regions',
  {
    description:
      'Распределение спроса по регионам для фразы (Яндекс Wordstat через XMLStock, ПЛАТНО — дороже топа/динамики). ' +
      'Возвращает [{ regionId, name, count, share, affinityIndex }]; имена регионов подставляются из дерева (кэш 24ч). ' +
      'ВНИМАНИЕ: при холодном кэше дерева (первый вызов за 24ч) делается дополнительный ПЛАТНЫЙ запрос regionsTree.',
    inputSchema: { query: z.string().min(1), account: accountParam },
  },
  safeHandler(async (args) => {
    const [json, names] = await Promise.all([wordstatGet('regions', { query: args.query }, args.account), wsRegionNames(args.account)]);
    return jsonResult({ query: args.query, results: parseRegions(json, names) });
  }),
);

server.registerTool(
  'xmlstock_wordstat_regions_tree',
  {
    description:
      'Дерево регионов Яндекс Wordstat через XMLStock (id + имя + путь) — id для параметра region в других запросах. ПЛАТНО за запрос.',
    inputSchema: { account: accountParam },
  },
  safeHandler(async (args) => {
    const json = await wordstatGet('regionsTree', {}, args.account);
    return jsonResult({ regions: flattenRegionsTree(json) });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[xmlstock] MCP-сервер запущен (stdio)');
