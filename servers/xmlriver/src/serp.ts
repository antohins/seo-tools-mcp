/**
 * HTTP-слой и хелперы SERP-выдачи XMLRiver (вынесены из index.ts ради юнит-тестов).
 * Нюансы API, сверенные на живых ответах (2026-07, user=7691):
 *  - groupby ИГНОРИРУЕТСЯ обоими движками (всегда 10 органических результатов на страницу,
 *    проверено groupby=10/30/100) — параметр НЕ шлём; глубина добирается пагинацией:
 *    Google — page с 1, Яндекс — page с 0; обрыв по первой пустой странице;
 *  - ошибки приходят HTTP 200 с XML <error code>: 20-25/101/110/111 — транзиентные (ретраим),
 *    500 — ретраим с паузами 5с/10с (по доке перезапрос «не раньше 5–10 с»; 4 подряд 500 →
 *    код 202, стоп на час, поэтому 2 ретрая достаточно), 202 — фатальная временная блокировка,
 *    15 = пустая выдача (деньги списаны, не ошибка), 31/42/45/200 — фатальные (авторизация/баланс);
 *  - highlights=1 на практике НЕ возвращает <hlword> (CDATA есть, подсветок нет) — не запрашиваем,
 *    text_bolds всегда пуст;
 *  - <ai><present>1</present></ai> приходит и без ai=1; полный текст AI Overview
 *    (ai=1 → <ai><answer>, base64-кодированный HTML страницы обзора, ~200 КБ) —
 *    ПЛАТНЫЙ параметр (доп. тарификация, замедляет выдачу), шлём только по явному
 *    includeAIOverview=true и только на первой странице Google;
 *  - у Google XMLRiver lr — код языка, а не регион: id региона Яндекса шлём только Яндексу;
 *  - у Яндекса XMLRiver filter — «скрывать похожие результаты» (включается filter=1),
 *    а не family-filter: moderate/strict/none туда слать нельзя — не шлём вовсе.
 */
import { CostLogger, fetchText, getConfig, requireEnv, resolveRegionId, sleep } from '@seo-tools/shared';
import { asArray, parseDocs, parseXml, type SerpDoc, stripTags } from '@seo-tools/shared/serp';

export const GOOGLE_URL = 'https://xmlriver.com/search/xml';
export const YANDEX_URL = 'https://xmlriver.com/search_yandex/xml';

// цена читается лениво из конфига — set_credentials применяется без перезапуска.
// Экспорт: suggest.ts использует тот же счётчик, чтобы расход по серверу суммировался.
export const cost = new CostLogger('xmlriver', () => Number(getConfig('XMLRIVER_PRICE_PER_CALL') || 0.02));

// Транзиентные коды в теле ответа (HTTP 200) — поисковая система не ответила; ретраятся.
// Кода 55 в доке XMLRiver нет (это XMLStock) — в набор не включён. Ошибки не тарифицируются.
const RETRIABLE_CODES = new Set([20, 21, 22, 23, 24, 25, 101, 110, 111]);
// 500 ретраим отдельно: по доке перезапрос «не раньше 5–10 с»; 4 подряд 500 → код 202
// (часовая блокировка), поэтому 2 ретрая (5 с, 10 с) достаточно.
const CODE_500_DELAYS = [5000, 10_000];

const MAX_ATTEMPTS = 4;

/** GET к XMLRiver: строит URL, парсит XML, ретраит транзиентные коды тела (code 15 = пустая выдача). */
export async function xmlriverGet(base: string, params: Record<string, string | number | undefined>, account?: string): Promise<any> {
  const user = requireEnv('XMLRIVER_USER', account);
  const key = requireEnv('XMLRIVER_KEY', account);
  const qs = new URLSearchParams({ user, key });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const url = `${base}?${qs}`;
  const engineLabel = base.includes('yandex') ? 'yandex' : 'google';
  let lastError = '';

  // бесконечный цикл: каждая итерация завершается return/continue/throw
  for (let attempt = 1; ; attempt++) {
    // fetchText сам ретраит сетевые/5xx/429 с backoff
    const text = await fetchText(url, { timeoutMs: 90_000 });
    const doc = parseXml(text);

    const err = doc?.yandexsearch?.response?.error;
    if (!err) {
      if (!doc?.yandexsearch?.response) {
        // не Yandex.XML (обычно HTML-страница ошибки при неверных ключах) — НЕ считаем
        // успешной пустой выдачей и НЕ тарифицируем: деньги такой ответ не списал
        throw new Error(
          'XMLRiver вернул не-XML/невалидный ответ — вероятно неверные XMLRIVER_USER/XMLRIVER_KEY (xmlriver_set_credentials / xmlriver_auth_status).',
        );
      }
      cost.track(engineLabel); // тарифицируются только успех и код 15 — ошибки бесплатны
      return doc;
    }

    const code = Number(err['@_code'] ?? 0);
    const message = stripTags(typeof err === 'string' ? err : (err['#text'] ?? ''));
    if (code === 15) {
      cost.track(engineLabel); // «ничего не найдено» — валидная пустая выдача, запрос тарифицирован
      return doc;
    }
    lastError = `XMLRiver error ${code}: ${message}`;

    // 202 — временная блокировка после повторных 500 (обычно на час): фатально, ретраить бессмысленно
    if (code === 202) {
      throw new Error(
        `${lastError} — временная блокировка XMLRiver после повторных ошибок 500, повторите запрос позже (обычно в пределах часа).`,
      );
    }
    // 31/42/45/200 — проблема авторизации/баланса: адресуем на ключи, а не сухой код
    if (code === 31 || code === 42 || code === 45 || code === 200) {
      throw new Error(
        `${lastError}. Похоже на проблему авторизации/баланса — проверьте XMLRIVER_USER/XMLRIVER_KEY (xmlriver_set_credentials / xmlriver_balance).`,
      );
    }
    // 500 — ретраим с паузами по доке (5 с, 10 с); дальше — сдаёмся, чтобы не словить 202
    if (code === 500) {
      if (attempt <= CODE_500_DELAYS.length) {
        const delay = CODE_500_DELAYS[attempt - 1];
        console.error(`[xmlriver] временная ошибка 500 (${message}) — ретрай ${attempt}/${CODE_500_DELAYS.length} через ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw new Error(`${lastError} — исчерпаны ретраи (${attempt} попытки)`);
    }
    const retriable = RETRIABLE_CODES.has(code);
    if (retriable && attempt < MAX_ATTEMPTS) {
      const delay = 1500 * attempt;
      console.error(`[xmlriver] временная ошибка ${code} (${message}) — ретрай ${attempt}/${MAX_ATTEMPTS - 1} через ${delay}ms`);
      await sleep(delay);
      continue;
    }
    // ретраибл-код на последней попытке — не глотаем код/текст, помечаем исчерпание ретраев
    if (retriable) {
      throw new Error(`${lastError} — исчерпаны ретраи (${MAX_ATTEMPTS} попытки)`);
    }
    throw new Error(lastError);
  }
}

/**
 * Число найденных из тела ответа. found может быть массивом (несколько priority)
 * или объектом с #text. Предпочитаем priority="all", фолбэк — первый элемент.
 * Легитимный 0 НЕ превращаем в null.
 */
export function extractFound(doc: any): number | null {
  const f = doc?.yandexsearch?.response?.found;
  const items = asArray<any>(f);
  const el = items.find((x) => x?.['@_priority'] === 'all') ?? items[0];
  const raw = typeof el === 'object' && el !== null ? el['#text'] : el;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Код 15 («ничего не найдено») — пустая выдача, запрос при этом тарифицирован. */
export function isEmptySerp(doc: any): boolean {
  return Number(doc?.yandexsearch?.response?.error?.['@_code'] ?? 0) === 15;
}

/** Флаг присутствия AI Overview (<ai><present>1</present></ai> — приходит и без ai=1). */
export function aiPresent(doc: any): boolean {
  return String(doc?.yandexsearch?.response?.ai?.present ?? '0') === '1';
}

// --- Полный AI Overview (ai=1, ПЛАТНО): <ai><answer> — base64-кодированный HTML страницы обзора ---

export interface AiOverview {
  /** <ai><present> — Google показывает блок AIO по запросу */
  present: boolean;
  /** false — answer не пришёл или Google ответил «обзор недоступен» */
  available: boolean;
  /** текст обзора (strip tags + нормализация пробелов), cap с маркером обрезки */
  text?: string;
  /** цитируемые внешние ссылки из HTML обзора (дедуп, без служебных доменов Google) */
  links?: string[];
}

const AI_TEXT_CAP = 4000;
const AI_LINKS_CAP = 30;
// домены служебных ссылок Google (не цитирование: search/support/accounts/политики, статика)
const AI_SKIP_DOMAINS = ['google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com'];
// маркеры «обзор недоступен» в тексте AIO (встречается лайвом)
const AI_UNAVAILABLE_RE = /обзор от ии недоступен|не удалось сгенерировать/i;

/** Декодирует base64 <answer> в HTML; битые/пустые данные → пустая строка. */
export function decodeAiAnswer(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Внешние href из HTML обзора: дедуп, без служебных доменов Google, cap. */
export function extractAiLinks(html: string, cap = AI_LINKS_CAP): string[] {
  const re = /href\s*=\s*["'](https?:\/\/[^"'<>\s]+)["']/gi;
  const seen = new Set<string>();
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && links.length < cap) {
    const url = m[1].replace(/&amp;/g, '&');
    if (seen.has(url)) continue;
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue; // невалидный URL — пропускаем
    }
    if (AI_SKIP_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    seen.add(url);
    links.push(url);
  }
  return links;
}

/** Текст обзора: strip tags + нормализация пробелов (внутри stripTags), cap с маркером. */
export function extractAiText(html: string, cap = AI_TEXT_CAP): string {
  // блочные теги → пробел, иначе stripTags склеит «абзац.Ссылка» без пробела
  const text = stripTags(html.replace(/<\/(p|div|li|ul|ol|h[1-6]|tr)>|<br\s*\/?>/gi, ' '));
  return text.length > cap ? `${text.slice(0, cap)}… [обрезано]` : text;
}

/**
 * Полный разбор блока <ai> при запрошенном ai=1. Отдельного элемента со ссылками
 * в ответе XMLRiver нет — ссылки извлекаются из HTML answer. Если answer не пришёл
 * или Google сообщил о недоступности обзора — available: false без text/links.
 */
export function parseAiOverview(doc: any): AiOverview {
  const present = aiPresent(doc);
  const html = decodeAiAnswer(doc?.yandexsearch?.response?.ai?.answer);
  if (!html) return { present, available: false };
  const text = extractAiText(html);
  if (AI_UNAVAILABLE_RE.test(text)) return { present, available: false };
  return { present, available: true, text, links: extractAiLinks(html) };
}

export interface SerpCollection {
  results: SerpDoc[];
  found: number | null;
  packs: string[];
  sitelinksTop1: string[];
  /** true — код 15: пустая выдача, запрос тарифицирован */
  empty: boolean;
  /** true — выдача кончилась раньше запрошенного depth */
  truncated: boolean;
  /** флаг <ai><present> (AI Overview) с первой страницы */
  ai: boolean;
  /** полный AI Overview (ai=1, платный) — только если запрошен aiOverview */
  aiOverview?: AiOverview;
}

/**
 * Постраничный сбор органики до depth; нумерация сквозная.
 * groupby у XMLRiver мёртв (всегда 10/страницу) — не шлём; Google page с 1, Яндекс page с 0.
 * aiOverview=true добавляет ai=1 (ПЛАТНЫЙ параметр) только в запрос первой страницы —
 * answer один на запрос, размножать доплату на все страницы пагинации незачем.
 */
export async function collectSerp(
  base: string,
  common: Record<string, string | number | undefined>,
  depth: number,
  account?: string,
  aiOverview = false,
): Promise<SerpCollection> {
  const firstPage = base === YANDEX_URL ? 0 : 1;
  // +1 страница добора: органики на странице бывает <10
  const maxPages = Math.ceil(depth / 10) + 1;
  let results: SerpDoc[] = [];
  let packs: string[] = [];
  let sitelinksTop1: string[] = [];
  let found: number | null = null;
  let empty = false;
  let ai = false;
  let overview: AiOverview | undefined;

  for (let i = 0; i < maxPages && results.length < depth; i++) {
    const doc = await xmlriverGet(base, { ...common, page: firstPage + i, ...(i === 0 && aiOverview ? { ai: 1 } : {}) }, account);
    const parsed = parseDocs(doc);
    if (i === 0) {
      packs = parsed.packs;
      sitelinksTop1 = parsed.sitelinksTop1;
      found = extractFound(doc);
      empty = isEmptySerp(doc);
      ai = aiPresent(doc);
      if (aiOverview) overview = parseAiOverview(doc);
    }
    // перенумеровываем сквозняком
    for (const d of parsed.docs) {
      d.position = results.length + 1;
      results.push(d);
    }
    if (!parsed.docs.length) break; // выдача кончилась
  }
  results = results.slice(0, depth);
  return {
    results,
    found,
    packs,
    sitelinksTop1,
    empty,
    truncated: results.length < depth,
    ai,
    ...(overview ? { aiOverview: overview } : {}),
  };
}

/**
 * Постраничный сбор Google-вертикали (images/news через setab) до depth; нумерация сквозная.
 * Размер страницы у вертикалей плавает (у images бывает 50) — обрыв по факту (пустая страница).
 */
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
  for (let page = 1; page <= maxPages && results.length < depth; page++) {
    const doc = await xmlriverGet(GOOGLE_URL, { ...common, page }, account);
    if (page === 1) {
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
 * Проверка индексации URL (inindex=1): один запрос, точный URL в выдаче по нему же.
 * Работает для обоих движков (Яндекс inindex проверен лайвом 2026-07).
 */
export async function checkIndex(
  url: string,
  engine: 'google' | 'yandex',
  strict: boolean,
  account?: string,
): Promise<{ url: string; engine: string; indexed: boolean; matchedUrl: string | null; found: number | null }> {
  // лимит API на длину query — 1400 символов (иначе ошибка 16); zod-валидация в index.ts дублирует
  if (url.length > 1400) {
    throw new Error(`XMLRiver ограничивает query 1400 символами (получено ${url.length}), иначе ошибка 16 API. Сократите URL.`);
  }
  const base = engine === 'yandex' ? YANDEX_URL : GOOGLE_URL;
  const params: Record<string, string | number | undefined> = { query: url, inindex: 1 };
  if (strict) params.strict = 1; // strict=0 не шлём — это дефолт API
  const doc = await xmlriverGet(base, params, account);
  const { docs } = parseDocs(doc);
  const norm = (u: string) => (strict ? u : u.toLowerCase()).replace(/\/+$/, '');
  const target = norm(url);
  const matched = docs.find((d) => norm(d.url) === target);
  return { url, engine, indexed: Boolean(matched), matchedUrl: matched?.url ?? null, found: extractFound(doc) };
}

export interface SerpParamsArgs {
  query: string;
  engine: 'google' | 'yandex';
  device: 'desktop' | 'mobile';
  region: string;
  searchDomain?: string;
  lang?: string;
  period?: string;
  exactQuery: boolean;
  safeSearch: 'moderate' | 'strict' | 'off';
  includeAds: boolean;
}

/**
 * Общие параметры xmlriver_serp. lr шлём ТОЛЬКО Яндексу (у Google XMLRiver lr — код языка,
 * id региона Яндекса туда слать нельзя). filter Яндексу НЕ шлём: у XMLRiver Яндекс filter —
 * «скрывать похожие результаты» (filter=1), семантически это не family-filter.
 */
export function buildSerpParams(args: SerpParamsArgs): Record<string, string | number | undefined> {
  const isGoogle = args.engine === 'google';
  const common: Record<string, string | number | undefined> = {
    query: args.query,
    device: args.device,
    // domain=ru строкой Google принимает без ошибки (проверено лайвом)
    domain: args.searchDomain ?? 'ru',
  };
  if (!isGoogle) {
    const lr = resolveLr(args.region);
    if (lr !== undefined) common.lr = lr;
  }
  if (args.includeAds) common.ads = 1;
  if (isGoogle) {
    if (args.lang) common.hl = args.lang;
    if (args.period) common.tbs = args.period;
    if (args.exactQuery) common.nfpr = 1;
    // moderate — дефолт Google (размытие), параметр в API не шлём
    if (args.safeSearch === 'strict') common.safe = 'on';
    else if (args.safeSearch === 'off') common.safe = 'off';
  } else {
    if (args.lang) common.lang = args.lang;
    if (args.period) common.within = args.period;
    if (args.exactQuery) common.noreask = 1;
  }
  return common;
}

/** Параметры Google-вертикали (images/news): lr не шлём (у Google XMLRiver lr — код языка). */
export function buildVerticalParams(args: {
  query: string;
  device: 'desktop' | 'mobile';
  searchDomain?: string;
}): Record<string, string | number | undefined> {
  return {
    query: args.query,
    device: args.device,
    domain: args.searchDomain ?? 'ru',
  };
}

/**
 * resolveRegionId с поправкой текста ошибки: у xmlriver своего дерева регионов нет,
 * советуем wordstat_regions_tree сервера wordstat.
 */
export function resolveLr(region?: string): number | undefined {
  try {
    return resolveRegionId(region);
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(
        err.message.replace(
          'инструмент wordstat_regions_tree',
          'инструмент wordstat_regions_tree сервера wordstat (у xmlriver дерева регионов нет)',
        ),
      );
    }
    throw err;
  }
}
