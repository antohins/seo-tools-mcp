/**
 * HTTP-слой и хелперы SERP-выдачи XMLStock (вынесены из index.ts ради юнит-тестов).
 * Ошибки приходят HTTP 200 с XML <error code>: 20-25/101/110/111/500 ретраим, 55 — rate-limit,
 * 15 = пустая выдача (деньги списаны, не ошибка), 31/42 — фатальные (авторизация).
 *
 * Движок yandex_xml (YANDEX_XML_URL) — официальный Яндекс XML через XMLStock:
 * настоящий формат Яндекс.XML (doc id, domain, modtime, saved-copy-url, is-local,
 * hlword в title и passages), found + found-docs (разные счётчики, НЕ путать),
 * страницы с 0, groupby до 100 РАБОТАЕТ (одна страница до 100 результатов за 1 запрос),
 * filter — семейный фильтр strict/moderate/none (корректный дом для safeSearch).
 * Тариф выше (от 24 ₽/1000) — отдельный CostLogger (XMLSTOCK_YANDEX_XML_PRICE_PER_CALL).
 */
import { CostLogger, fetchText, getConfig, requireEnv, resolveRegionId, sleep } from '@seo-tools/shared';
import { asArray, domainOf, parseDocs, parseXml, type SerpDoc, stripTags } from '@seo-tools/shared/serp';

export const GOOGLE_URL = 'https://xmlstock.com/google/xml/';
export const YANDEX_URL = 'https://xmlstock.com/yandexlive/xml/';
export const YANDEX_XML_URL = 'https://xmlstock.com/yandex/xml/';

// цена читается лениво из конфига — set_credentials применяется без перезапуска
const cost = new CostLogger('xmlstock', () => Number(getConfig('XMLSTOCK_PRICE_PER_CALL') || 0.02));

// официальный Яндекс XML дороже SERP (от 24 ₽/1000 против ~12-20 ₽/1K) — отдельный счётчик расхода
export const yandexXmlCost = new CostLogger('xmlstock-yandex-xml', () => Number(getConfig('XMLSTOCK_YANDEX_XML_PRICE_PER_CALL') || 0.024));

const RETRIABLE_CODES = new Set([20, 21, 22, 23, 24, 25, 101, 110, 111, 500]);
const RATE_LIMIT_CODES = new Set([55]);

/** GET к XMLStock c ретраем на «временные» коды ошибок из тела XML. */
export async function xmlstockGet(
  base: string,
  params: Record<string, string | number | undefined>,
  account?: string,
  costLogger: CostLogger = cost,
): Promise<any> {
  const user = requireEnv('XMLSTOCK_USER', account);
  const key = requireEnv('XMLSTOCK_KEY', account);
  const qs = new URLSearchParams({ user, key });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const url = `${base}?${qs}`;
  const MAX_ATTEMPTS = 4;

  const engineLabel = base.includes('google') ? 'google' : base.includes('yandex/xml') ? 'yandex_xml' : 'yandex';
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const text = await fetchText(url, { timeoutMs: 90_000 });
    const doc = parseXml(text);
    const err = doc?.yandexsearch?.response?.error;
    if (!err) {
      if (!doc?.yandexsearch?.response) {
        // HTML-заглушка/мусор (обычно при неверных ключах) — НЕ считаем успешной пустой выдачей
        // и НЕ тарифицируем: такой ответ не списал деньги, это сбой транспорта/авторизации
        throw new Error(
          'XMLStock вернул не-XML/невалидный ответ — вероятно неверные XMLSTOCK_USER/XMLSTOCK_KEY (xmlstock_set_credentials / xmlstock_auth_status).',
        );
      }
      costLogger.track(engineLabel); // тарифицируются только успех и код 15 — ошибки бесплатны
      return doc;
    }

    const code = Number(err['@_code'] ?? 0);
    const message = stripTags(typeof err === 'string' ? err : (err['#text'] ?? ''));
    if (code === 15) {
      costLogger.track(engineLabel);
      return doc; // «ничего не найдено» — нормальная пустая выдача, деньги списаны
    }
    lastError = `XMLStock error ${code}: ${message}`;
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
    // ретраибл-код на последней попытке — не глотаем код/текст, помечаем исчерпание ретраев
    if (retriable) {
      throw new Error(`${lastError} — исчерпаны ретраи (${MAX_ATTEMPTS} попытки)`);
    }
    throw new Error(lastError);
  }
  // недостижимо (последняя попытка всегда бросает выше), оставлено для полноты типов
  throw new Error(`${lastError || 'XMLStock'} — исчерпаны ретраи (${MAX_ATTEMPTS} попытки)`);
}

/**
 * Число из узла с priority (found / found-docs). Узел может быть массивом (несколько priority)
 * или объектом с #text. Предпочитаем priority="all" (лайв: сейчас XMLStock отдаёт
 * только его), фолбэк — первый элемент. Легитимный 0 НЕ превращаем в null.
 */
function extractPriorityNumber(node: any): number | null {
  const items = asArray<any>(node);
  const el = items.find((x) => x?.['@_priority'] === 'all') ?? items[0];
  const raw = typeof el === 'object' && el !== null ? el['#text'] : el;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * «Всего найдено» из <found priority="all">. НЕ путать с <found-docs> (found-docs —
 * число документов, found — оценка по запросу): это разные элементы ответа.
 */
export function extractFound(doc: any): number | null {
  return extractPriorityNumber(doc?.yandexsearch?.response?.found);
}

/** Число найденных документов из <found-docs priority="all"> (официальный Яндекс XML). */
export function extractFoundDocs(doc: any): number | null {
  return extractPriorityNumber(doc?.yandexsearch?.response?.['found-docs']);
}

/** Человекочитаемая строка «найдено» из <found-docs-human> (официальный Яндекс XML). */
export function extractFoundHuman(doc: any): string | null {
  const v = doc?.yandexsearch?.response?.['found-docs-human'];
  if (v === undefined || v === null || v === '') return null;
  return String(v);
}

/** Код 15 («ничего не найдено») — пустая выдача, запрос при этом тарифицирован. */
export function isEmptySerp(doc: any): boolean {
  return Number(doc?.yandexsearch?.response?.error?.['@_code'] ?? 0) === 15;
}

/** SERP-фичи из addresults: featured snippet, PAA (только Google), related searches. */
export function parseFeatures(doc: any) {
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

export interface SerpCollection {
  results: SerpDoc[];
  found: number | null;
  /** found-docs priority="all" — только официальный Яндекс XML (иначе null) */
  foundDocs: number | null;
  /** found-docs-human — человекочитаемая строка «найдено» (только yandex_xml) */
  foundHuman: string | null;
  features: ReturnType<typeof parseFeatures> | null;
  packs: string[];
  sitelinksTop1: string[];
  /** true — код 15: пустая выдача, запрос тарифицирован */
  empty: boolean;
  /** true — выдача кончилась раньше запрошенного depth */
  truncated: boolean;
}

export interface CollectSerpOptions {
  /**
   * groupby (размер страницы) — работает только у официального Яндекс XML (до 100);
   * у live-движков groupby мёртв (всегда 10) и параметр не шлём.
   */
  groupby?: number;
  /** отдельный счётчик расхода (yandex_xml — свой тариф) */
  cost?: CostLogger;
}

/** Постраничный сбор органики до depth; нумерация сквозная, страницы с 0. */
export async function collectSerp(
  base: string,
  common: Record<string, string | number | undefined>,
  depth: number,
  account?: string,
  opts?: CollectSerpOptions,
): Promise<SerpCollection> {
  // размер страницы: 10 у live-движков, groupby (до 100) у официального Яндекс XML
  const pageSize = opts?.groupby ?? 10;
  // +1 страница добора: органики на странице бывает меньше pageSize (Google выдаёт 9, режет видео-блоки)
  const maxPages = Math.ceil(depth / pageSize) + 1;
  let results: SerpDoc[] = [];
  let features: SerpCollection['features'] = null;
  let packs: string[] = [];
  let sitelinksTop1: string[] = [];
  let found: number | null = null;
  let foundDocs: number | null = null;
  let foundHuman: string | null = null;
  let empty = false;

  for (let page = 0; page < maxPages && results.length < depth; page++) {
    // нумерация страниц у XMLStock с 0 для всех движков
    const doc = await xmlstockGet(base, { ...common, page, ...(opts?.groupby ? { groupby: opts.groupby } : {}) }, account, opts?.cost);
    const parsed = parseDocs(doc);
    if (page === 0) {
      features = parseFeatures(doc);
      packs = parsed.packs;
      sitelinksTop1 = parsed.sitelinksTop1;
      found = extractFound(doc);
      foundDocs = extractFoundDocs(doc);
      foundHuman = extractFoundHuman(doc);
      empty = isEmptySerp(doc);
    }
    // перенумеровываем сквозняком
    for (const d of parsed.docs) {
      d.position = results.length + 1;
      results.push(d);
    }
    // выдача кончилась: 0 документов, либо (у yandex_xml с groupby) неполная страница —
    // частичная страница = последняя, добор ещё одной страницы был бы лишним ПЛАТНЫМ запросом.
    // У live-движков (pageSize=10) так делать нельзя: Google легально отдаёт 9 на неполной странице.
    if (!parsed.docs.length || (opts?.groupby && parsed.docs.length < pageSize)) break;
  }
  results = results.slice(0, depth);
  return { results, found, foundDocs, foundHuman, features, packs, sitelinksTop1, empty, truncated: results.length < depth };
}

/** Постраничный сбор Google-вертикали (images/news/video) до depth; нумерация сквозная. */
export async function collectVertical<T extends { position: number }>(
  common: Record<string, string | number | undefined>,
  depth: number,
  parse: (doc: any) => T[],
  account?: string,
): Promise<{ results: T[]; found: number | null; empty: boolean; truncated: boolean }> {
  const maxPages = Math.ceil(depth / 10) + 1;
  const results: T[] = [];
  let found: number | null = null;
  let empty = false;
  for (let page = 0; page < maxPages && results.length < depth; page++) {
    const doc = await xmlstockGet(GOOGLE_URL, { ...common, page }, account);
    if (page === 0) {
      found = extractFound(doc);
      empty = isEmptySerp(doc);
    }
    const items = parse(doc);
    if (!items.length) break;
    for (const it of items) {
      it.position = results.length + 1;
      results.push(it);
    }
  }
  const sliced = results.slice(0, depth);
  return { results: sliced, found, empty, truncated: sliced.length < depth };
}

/**
 * resolveRegionId с поправкой текста ошибки: shared-версия советует инструмент
 * wordstat_regions_tree (другой сервер); здесь подменяем на xmlstock-аналог.
 */
export function resolveLr(region?: string): number | undefined {
  try {
    return resolveRegionId(region);
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(
        err.message.replace(
          'инструмент wordstat_regions_tree',
          'инструмент xmlstock_wordstat_regions_tree (ПЛАТНЫЙ) или wordstat_regions_tree сервера wordstat',
        ),
      );
    }
    throw err;
  }
}

/** Общая часть параметров запроса для Google-вертикали (images/news/video). */
export function verticalCommon(args: {
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
  const lr = resolveLr(args.region);
  if (lr !== undefined) common.lr = lr;
  if (args.safeSearch === 'strict') common.safe = 'on';
  else if (args.safeSearch === 'off') common.safe = 'off';
  return common;
}

/**
 * Параметры официального Яндекс XML (engine=yandex_xml). Отличия от live-движков:
 * hlword приходит нативно (параметр не нужен), device/domain/ads/related не применимы;
 * filter — семейный фильтр strict/moderate/none (сюда корректно маппится safeSearch);
 * lr по духу API обязателен (у нас region имеет дефолт, так что lr всегда есть).
 */
export function yandexXmlCommon(args: {
  query: string;
  region: string;
  sortby: 'relevance' | 'date';
  safeSearch: 'moderate' | 'strict' | 'off';
  maxpassages?: number;
}): Record<string, string | number | undefined> {
  const common: Record<string, string | number | undefined> = {
    query: args.query,
    lr: resolveLr(args.region),
    // safeSearch → filter: moderate (дефолт) / strict / none (off)
    filter: args.safeSearch === 'off' ? 'none' : args.safeSearch,
  };
  if (args.sortby === 'date') common.sortby = 'tm'; // rlv (релевантность) — дефолт API, не шлём
  if (args.maxpassages) common.maxpassages = args.maxpassages; // пассажей-сниппетов на документ (1–5)
  return common;
}
