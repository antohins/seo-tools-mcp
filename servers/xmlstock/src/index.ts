#!/usr/bin/env node
/**
 * xmlstock-mcp — SERP Google/Yandex через XMLStock (xmlstock.com) для SEO-пайплайна.
 * Авторизация: env XMLSTOCK_USER, XMLSTOCK_KEY. Сервис ПЛАТНЫЙ за запрос —
 * число вызовов и оценка расхода логируются в stderr.
 * Питает: BASELINE 2.1/2.2, A.3, A.9, A.10.
 *
 * Нюансы API: подсветки — hlword=1 (вложенный тег <hlword>, БЕЗ CDATA);
 * PAA + related searches — related=1 (PAA только у Google);
 * страницы с 0 у обоих движков; глубина только пагинацией (groupby мёртв, всегда 10);
 * lr принимает id регионов Яндекса и для Google (авто-маппинг на стороне XMLStock);
 * ошибки приходят HTTP 200 с XML <error code>: 20-25/101/110/111/500 ретраить, 55 rate-limit,
 * 15 = пустая выдача (деньги списаны), 31/42 — фатальные (авторизация), 200 — фатальная.
 * Wordstat у XMLStock НЕТ — частотности идут через отдельный сервер wordstat.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  accountParam,
  CostLogger,
  fetchJson,
  fetchText,
  getConfig,
  HttpError,
  jsonResult,
  loadSharedEnv,
  registerAuthTools,
  requireEnv,
  resolveRegionId,
  safeHandler,
  sleep,
} from '@seo-tools/shared';
import { asArray, domainOf, parseDocs, parseXml, type SerpDoc, stripTags } from '@seo-tools/shared/serp';
import { z } from 'zod';
import { parseImages, parseNews, parseVideo } from './verticals.js';

loadSharedEnv();

const GOOGLE_URL = 'https://xmlstock.com/google/xml/';
const YANDEX_URL = 'https://xmlstock.com/yandexlive/xml/';
const BALANCE_URL = 'https://xmlstock.com/api/?do=balance';

// цена читается лениво из конфига — set_credentials применяется без перезапуска
const cost = new CostLogger('xmlstock', () => Number(getConfig('XMLSTOCK_PRICE_PER_CALL') || 0.02));

// Домены-агрегаторы, исключаемые флагом excludeAggregators (переопределяются env-ом,
// читаются лениво — set_credentials применяется без перезапуска)
const DEFAULT_AGGREGATORS = 'avito.ru,cian.ru,domclick.ru,yandex.ru,m2.ru,youla.ru';
const aggregators = (): string[] =>
  (getConfig('XMLSTOCK_EXCLUDE_DOMAINS') || DEFAULT_AGGREGATORS)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const RETRIABLE_CODES = new Set([20, 21, 22, 23, 24, 25, 101, 110, 111, 500]);
const RATE_LIMIT_CODES = new Set([55]);

/** GET к XMLStock c ретраем на «временные» коды ошибок из тела XML. */
async function xmlstockGet(base: string, params: Record<string, string | number | undefined>, account?: string): Promise<any> {
  const user = requireEnv('XMLSTOCK_USER', account);
  const key = requireEnv('XMLSTOCK_KEY', account);
  const qs = new URLSearchParams({ user, key });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const url = `${base}?${qs}`;
  const MAX_ATTEMPTS = 4;

  const engineLabel = base.includes('google') ? 'google' : 'yandex';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = await fetchText(url, { timeoutMs: 90_000 });
    const doc = parseXml(text);
    const err = doc?.yandexsearch?.response?.error;
    if (!err) {
      cost.track(engineLabel); // тарифицируются только успех и код 15 — ошибки бесплатны
      return doc;
    }

    const code = Number(err['@_code'] ?? 0);
    const message = stripTags(typeof err === 'string' ? err : (err['#text'] ?? ''));
    if (code === 15) {
      cost.track(engineLabel);
      return doc; // «ничего не найдено» — нормальная пустая выдача, деньги списаны
    }
    const retriable = RETRIABLE_CODES.has(code) || RATE_LIMIT_CODES.has(code);
    if (retriable && attempt < MAX_ATTEMPTS) {
      const delay = RATE_LIMIT_CODES.has(code) ? 2000 : 1500 * attempt;
      console.error(`[xmlstock] временная ошибка ${code} (${message}) — ретрай ${attempt}/${MAX_ATTEMPTS - 1} через ${delay}ms`);
      await sleep(delay);
      continue;
    }
    // 31/42 — проблема авторизации: адресуем на ключи, а не сухой код
    if (code === 31 || code === 42) {
      throw new Error(
        `XMLStock error ${code}: ${message}. Похоже на проблему авторизации — проверьте XMLSTOCK_USER/XMLSTOCK_KEY (xmlstock_set_credentials / xmlstock_auth_status).`,
      );
    }
    throw new Error(`XMLStock error ${code}: ${message}`);
  }
  throw new Error('XMLStock: исчерпаны ретраи');
}

function parseFeatures(doc: any) {
  const add = doc?.yandexsearch?.response?.addresults;

  let featured: { type: string; domain: string; text: string } | null = null;
  const zero = add?.zeroposition;
  if (zero) {
    const url = String(zero?.url ?? '');
    featured = {
      type: zero?.snippettable ? 'table' : 'paragraph',
      domain: domainOf(url),
      text: stripTags(String(zero?.snippet ?? zero?.title ?? '')),
    };
  }

  const paa = asArray<any>(add?.relatedQuestions?.item)
    .map((q) => stripTags(String(typeof q === 'string' ? q : (q?.question ?? q?.title ?? ''))))
    .filter(Boolean);

  const related = asArray<any>(add?.relatedSearches?.query)
    .map((q) => stripTags(String(typeof q === 'string' ? q : (q?.title ?? ''))))
    .filter(Boolean);

  return {
    featured_snippet: featured,
    paa: [...new Set(paa)],
    related: [...new Set(related)],
  };
}

const server = new McpServer({ name: 'xmlstock', version: '1.0.0' });

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
      '1) Регистрация на https://xmlstock.com → личный кабинет. 2) Пополнить баланс (Google XML от 12 ₽/1000, Яндекс Live от 12 ₽/1000). ' +
      '3) Взять ID пользователя и API-ключ из кабинета. 4) В настройках кабинета можно задать регион по умолчанию. ' +
      'Проверка после сохранения — xmlstock_balance.',
  },
);

/** Число найденных из тела ответа (found может быть массивом/объектом с #text). */
function extractFound(doc: any): number | null {
  const f = doc?.yandexsearch?.response?.found;
  const fv = Array.isArray(f) ? f[0] : f;
  return Number(typeof fv === 'object' ? fv?.['#text'] : fv) || null;
}

/** Постраничный сбор Google-вертикали (images/news/video) до depth; нумерация сквозная. */
async function collectVertical<T extends { position: number }>(
  common: Record<string, string | number | undefined>,
  depth: number,
  parse: (doc: any) => T[],
  account?: string,
): Promise<{ results: T[]; found: number | null }> {
  const maxPages = Math.ceil(depth / 10) + 1;
  const results: T[] = [];
  let found: number | null = null;
  for (let page = 0; page < maxPages && results.length < depth; page++) {
    const doc = await xmlstockGet(GOOGLE_URL, { ...common, page }, account);
    if (page === 0) found = extractFound(doc);
    const items = parse(doc);
    if (!items.length) break;
    for (const it of items) {
      it.position = results.length + 1;
      results.push(it);
    }
  }
  return { results: results.slice(0, depth), found };
}

server.registerTool(
  'xmlstock_serp',
  {
    description:
      'Слепок выдачи Google/Yandex через XMLStock (ПЛАТНО за запрос). ' +
      'Возвращает органику с подсветками (text_bolds) + serp_features (PAA — только Google, related, packs). ' +
      'depth>10 добирается пагинацией (каждая страница — отдельный платный запрос). ' +
      'region: название («Москва», «Россия») или числовой id региона Яндекса — работает для ОБОИХ движков. ' +
      'ОГРАНИЧЕНИЕ ИСТОЧНИКА: device=mobile отдаёт только позиции и сниппеты — без hlword/PAA/related; ' +
      'подсветки и SERP-фичи снимать с desktop.',
    inputSchema: {
      query: z.string().min(1),
      engine: z.enum(['google', 'yandex']).default('google'),
      device: z.enum(['desktop', 'mobile']).default('desktop'),
      region: z.string().default('Москва').describe('«Москва»/«Россия»/213/225 — id Яндекса, XMLStock маппит и на Google'),
      depth: z.number().int().min(1).max(30).default(10).describe('Сколько органических позиций собрать'),
      excludeAggregators: z
        .boolean()
        .default(false)
        .describe(
          'Исключить домены-агрегаторы из органики (список — XMLSTOCK_EXCLUDE_DOMAINS, дефолт: avito/cian/domclick/yandex/m2/youla)',
        ),
      includeAds: z.boolean().default(false).describe('Добавить рекламные блоки (ads=1)'),
      searchDomain: z.string().optional().describe('Доменная зона: google — ru/com/de..., yandex — ru/by/kz/com.tr (по умолчанию ru)'),
      lang: z.string().optional().describe('Google hl (язык интерфейса), Yandex lang'),
      period: z.string().optional().describe('Google tbs (qdr:m, qdr:y...) / Yandex within (77=сутки, 1=2 недели, 2=месяц)'),
      exactQuery: z.boolean().default(false).describe('Не исправлять запрос (nfpr=1 / noreask=1)'),
      safeSearch: z
        .enum(['moderate', 'strict', 'off'])
        .default('moderate')
        .describe('Безопасный поиск: Google safe (moderate=размытие/strict=фильтр/off), Yandex filter (moderate/strict/none)'),
      includeSimilar: z.boolean().default(false).describe('Google: показать скрытые похожие результаты (filter=1)'),
      sortby: z.enum(['relevance', 'date']).default('relevance').describe('Yandex: сортировка выдачи (rlv / tm — по дате)'),
      maxpassages: z.number().int().min(1).max(5).optional().describe('Yandex: сколько пассажей-сниппетов на документ (1–5)'),
      l10n: z.string().optional().describe('Yandex: язык уведомлений (ru/uk/be/kk/tr/en)'),
      account: accountParam,
    },
  },
  safeHandler(async (args) => {
    const isGoogle = args.engine === 'google';
    const base = isGoogle ? GOOGLE_URL : YANDEX_URL;
    // +1 страница добора: органики на странице бывает <10 (Google выдаёт 9, режет видео-блоки)
    const maxPages = Math.ceil(args.depth / 10) + 1;

    const common: Record<string, string | number | undefined> = {
      query: args.query,
      device: args.device,
      hlword: 1, // подсветки <hlword> — критичны для блока A
      related: 1, // PAA (google) + related searches
      domain: args.searchDomain ?? 'ru',
    };
    const lr = resolveRegionId(args.region);
    if (lr !== undefined) common.lr = lr;
    if (args.includeAds) common.ads = 1;
    if (isGoogle) {
      if (args.lang) common.hl = args.lang;
      if (args.period) common.tbs = args.period;
      if (args.exactQuery) common.nfpr = 1;
      if (args.safeSearch === 'strict') common.safe = 'on';
      else if (args.safeSearch === 'off') common.safe = 'off';
      if (args.includeSimilar) common.filter = 1;
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

    let results: SerpDoc[] = [];
    let features: ReturnType<typeof parseFeatures> | null = null;
    let firstPagePacks: string[] = [];
    let firstPageSitelinks: string[] = [];
    let found: number | null = null;

    for (let page = 0; page < maxPages && results.length < args.depth; page++) {
      // нумерация страниц у XMLStock с 0 для обоих движков
      const doc = await xmlstockGet(base, { ...common, page }, args.account);
      const { docs, packs, sitelinksTop1 } = parseDocs(doc);
      if (page === 0) {
        features = parseFeatures(doc);
        firstPagePacks = packs;
        firstPageSitelinks = sitelinksTop1;
        const f = doc?.yandexsearch?.response?.found;
        const fv = Array.isArray(f) ? f[0] : f;
        found = Number(typeof fv === 'object' ? fv?.['#text'] : fv) || null;
      }
      // перенумеровываем сквозняком
      for (const d of docs) {
        d.position = results.length + 1;
        results.push(d);
      }
      if (!docs.length) break; // выдача кончилась
    }

    if (args.excludeAggregators) {
      const aggs = aggregators();
      results = results.filter((r) => !aggs.some((a) => r.domain === a || r.domain.endsWith(`.${a}`)));
      results.forEach((r, i) => {
        r.position = i + 1;
      });
    }
    results = results.slice(0, args.depth);

    return jsonResult({
      query: args.query,
      engine: args.engine,
      device: args.device,
      region: args.region,
      found,
      results,
      serp_features: {
        ...(features ?? { featured_snippet: null, paa: [], related: [] }),
        sitelinks_top1: firstPageSitelinks,
        packs: firstPagePacks,
      },
    });
  }),
);

const verticalInput = {
  query: z.string().min(1),
  region: z.string().default('Москва').describe('«Москва»/«Россия»/213/225 — id Яндекса, XMLStock маппит на Google'),
  depth: z.number().int().min(1).max(50).default(20).describe('Сколько результатов собрать (пагинация, каждая страница — платный запрос)'),
  device: z.enum(['desktop', 'mobile']).default('desktop'),
  searchDomain: z.string().optional().describe('Доменная зона Google (ru/com/de...), по умолчанию ru'),
  safeSearch: z.enum(['moderate', 'strict', 'off']).default('moderate').describe('Безопасный поиск (safe: размытие/фильтр/выкл)'),
  account: accountParam,
};

/** Общая часть параметров запроса для Google-вертикали. */
function verticalCommon(args: {
  query: string;
  region: string;
  device: string;
  searchDomain?: string;
  safeSearch: 'moderate' | 'strict' | 'off';
}): Record<string, string | number | undefined> {
  const common: Record<string, string | number | undefined> = {
    query: args.query,
    domain: args.searchDomain ?? 'ru',
    device: args.device,
  };
  const lr = resolveRegionId(args.region);
  if (lr !== undefined) common.lr = lr;
  if (args.safeSearch === 'strict') common.safe = 'on';
  else if (args.safeSearch === 'off') common.safe = 'off';
  return common;
}

server.registerTool(
  'xmlstock_images',
  {
    description:
      'Поиск по картинкам Google через XMLStock (ПЛАТНО за запрос). ' +
      'Возвращает { position, url (страница-источник), imageUrl (сама картинка), title }.',
    inputSchema: verticalInput,
  },
  safeHandler(async (args) => {
    const common = { ...verticalCommon(args), tbm: 'images' };
    const { results, found } = await collectVertical(common, args.depth, parseImages, args.account);
    return jsonResult({ query: args.query, tbm: 'images', region: args.region, found, count: results.length, results });
  }),
);

server.registerTool(
  'xmlstock_news',
  {
    description:
      'Поиск по новостям Google через XMLStock (ПЛАТНО за запрос). ' +
      'Возвращает { position, url, title, source (издание), date (часто относительная), snippet }.',
    inputSchema: verticalInput,
  },
  safeHandler(async (args) => {
    const common = { ...verticalCommon(args), tbm: 'news' };
    const { results, found } = await collectVertical(common, args.depth, parseNews, args.account);
    return jsonResult({ query: args.query, tbm: 'news', region: args.region, found, count: results.length, results });
  }),
);

server.registerTool(
  'xmlstock_video',
  {
    description:
      'Поиск по видео Google через XMLStock (ПЛАТНО за запрос). ' +
      'Возвращает { position, url, title, thumbnail, host (YouTube...), channel, duration, snippet }.',
    inputSchema: verticalInput,
  },
  safeHandler(async (args) => {
    const common = { ...verticalCommon(args), tbm: 'video' };
    const { results, found } = await collectVertical(common, args.depth, parseVideo, args.account);
    return jsonResult({ query: args.query, tbm: 'video', region: args.region, found, count: results.length, results });
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[xmlstock] MCP-сервер запущен (stdio)');
