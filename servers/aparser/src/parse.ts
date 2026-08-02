/**
 * Чистые парсеры ответов A-Parser API (без сети — покрыты юнит-тестами).
 *
 * Формы сверены на живом инстансе A-Parser v1.2.3527 (getParserInfo + oneRequest):
 *  - SE::Google/SE::Yandex serp[] = {link, anchor, snippet, flags, …}; позиция по индексу;
 *  - query приходит объектом {query,orig,first}; related — массив {key};
 *  - пустые значения приходят строкой «none»; SE::*::Suggest кладёт results[].suggest.
 * Доступ к полям защитный (алиасы) — при вариациях правится только маппинг здесь.
 */

/** Число из строки/значения: терпит пробелы-разделители («132 584»), иначе 0. */
export const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(/\s+/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (v == null ? '' : String(v));

/** A-Parser отдаёт пустые значения строкой «none» — трактуем как пусто. */
const NONE = new Set(['', 'none', 'None', 'NONE']);
const clean = (v: unknown): string => {
  const s = str(v);
  return NONE.has(s) ? '' : s;
};

/** Первое непустое значение по списку ключей-алиасов. */
const pick = (o: any, keys: string[]): unknown => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) {
    if (o[k] != null && o[k] !== '') return o[k];
  }
  return undefined;
};

/** query приходит объектом {query,orig,first} (rawResults) или строкой — приводим к строке. */
function queryString(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  if (typeof q === 'object') return str(pick(q, ['query', 'orig', 'first']));
  return str(q);
}

export interface SerpItem {
  position: number;
  url: string;
  anchor: string;
  snippet: string;
  flags?: unknown;
}

/** Нормализует один элемент выдачи (алиасы link/url, anchor/title, snippet/desc, pos/position). */
export function normSerpItem(it: any, i: number): SerpItem {
  const item: SerpItem = {
    position: num(pick(it, ['pos', 'position', 'number'])) || i + 1,
    url: str(pick(it, ['link', 'url'])),
    anchor: str(pick(it, ['anchor', 'title', 'text'])),
    snippet: str(pick(it, ['snippet', 'desc', 'description'])),
  };
  if (it && it.flags != null) item.flags = it.flags;
  return item;
}

export interface SerpResult {
  query: string;
  success: boolean;
  /** Легитимная пустая выдача: запрос выполнен (success), но органики нет. */
  empty: boolean;
  totalcount: number | null;
  misspell: string | null;
  count: number;
  serp: SerpItem[];
  related: string[];
  ads: SerpItem[];
  diagnostic?: string;
}

/** Человекочитаемая причина пустой выдачи (капча/выжженные прокси) из info.stats. */
function diagnose(r: any): string {
  const stats = r?.info?.stats || {};
  const captcha = num(stats.reCaptchaShows);
  const retries = num(stats.retries ?? r?.info?.retries);
  if (captcha > 0) {
    return `Поисковик отдал reCaptcha (${captcha} показов за ${retries} ретраев), прокси её не решили — нужны свежие/качественные прокси или решатель капчи (Util::ReCaptcha2).`;
  }
  return `Выдача не получена за ${retries} ретраев — вероятно, прокси выжжены или заблокированы. Проверьте aparser_proxies.`;
}

/** Нормализует один result-объект oneRequest/bulkRequest в стабильную SERP-форму. */
export function parseSerpResult(result: any): SerpResult {
  const r = result || {};
  const serp = Array.isArray(r.serp) ? r.serp : [];
  const related = Array.isArray(r.related) ? r.related : [];
  const ads = Array.isArray(r.ads) ? r.ads : [];
  const success = r.success !== false && r.success !== 0;
  const misspell = clean(r.misspell);
  const out: SerpResult = {
    query: queryString(r.query),
    success,
    empty: success && serp.length === 0,
    totalcount: num(pick(r, ['totalcount', 'totalCount'])) || null,
    misspell: misspell || null,
    count: serp.length,
    serp: serp.map(normSerpItem),
    // Google/Yandex related — массив {key}; терпим и алиасы на случай других парсеров.
    related: related
      .map((x: any) => str(typeof x === 'string' ? x : pick(x, ['key', 'anchor', 'keyword', 'query', 'text'])))
      .filter(Boolean),
    ads: ads.map(normSerpItem),
  };
  if (!success) out.diagnostic = diagnose(r);
  return out;
}

/** results[0] из data (oneRequest — один запрос). */
export function firstResult(data: any): any {
  const arr = data && Array.isArray(data.results) ? data.results : [];
  return arr.length ? arr[0] : null;
}

/** Все result-объекты (bulkRequest). */
export function allResults(data: any): any[] {
  return data && Array.isArray(data.results) ? data.results : [];
}

/**
 * Пояснение к results_present=false: «success, но results нет/пуст» — это НЕ легитимная
 * пустая выдача (у неё всегда есть results[0] с пустым serp), а битый/неожиданный ответ API.
 */
export const NO_RESULTS_NOTE =
  'A-Parser вернул success, но поле results отсутствует или пусто — это НЕ легитимная пустая выдача ' +
  '(у пустой выдачи есть results[0] с пустым serp). Проверьте пресет и парсер (aparser_get_preset, aparser_parser_fields).';

/** results есть и непуст? Отличает битый ответ API от легитимной пустой выдачи. */
export function resultsPresent(data: any): boolean {
  return !!(data && Array.isArray(data.results) && data.results.length > 0);
}

/** Маркер для ответа инструмента: results_present + note, когда results нет (без throw). */
export function resultsMarker(data: any): { results_present: boolean; note?: string } {
  return resultsPresent(data) ? { results_present: true } : { results_present: false, note: NO_RESULTS_NOTE };
}

/** SERP-парсеры, чьи результаты нормализуются parseSerpResult; остальные отдаются как есть. */
export function isSerpParser(parser: string): boolean {
  return /^SE::(Google|Yandex)$/.test(parser);
}

/**
 * Результаты bulkRequest: нормализация parseSerpResult только для SE::Google/SE::Yandex —
 * у остальных парсеров структура своя, parseSerpResult исказил бы её. raw=false — как есть.
 */
export function normalizeBulkResults(parser: string, results: any[], raw: boolean): any[] {
  if (!raw || !isSerpParser(parser)) return results;
  return results.map((r) => parseSerpResult(r));
}

/** Подсказка из объектного элемента (без алиаса link — URL подсказкой не является). */
const suggestFromObjects = (arr: any[]): string[] =>
  arr.map((x: any) => str(typeof x === 'string' ? x : pick(x, ['suggest', 'anchor', 'keyword', 'text']))).filter(Boolean);

/**
 * Подсказки из suggest-парсера. В rawResults SE::*::Suggest отдаёт results ПЛОСКИМ
 * массивом [suggest, type, suggest, type, …]; маркер типа — целое число (иногда строкой
 * «1», т.к. A-Parser на Perl), поэтому отсеиваем чисто числовые элементы, а не только JS-числа.
 * Терпит и объектные/альтернативные формы (suggest[]/serp[]) на случай других парсеров.
 */
export function parseSuggest(result: any): string[] {
  const r = result || {};
  if (Array.isArray(r.results)) {
    if (r.results.some((x: any) => x && typeof x === 'object')) return suggestFromObjects(r.results);
    // плоский скалярный [suggest, type, …]: числовые маркеры типа (в т.ч. строкой) отбрасываем
    return r.results.map(str).filter((x: string) => x && !/^\d+$/.test(x));
  }
  const raw = Array.isArray(r.suggest) ? r.suggest : Array.isArray(r.suggestions) ? r.suggestions : Array.isArray(r.serp) ? r.serp : [];
  return suggestFromObjects(raw);
}

export interface InstanceInfo {
  version: string | null;
  parsersCount: number;
  parsers: string[];
  tasksInQueue: number;
  workingTasks: number;
  activeThreads: number;
  activeProxyCheckerThreads: number;
  pid: string | null;
}

/** Ответ info: версия, установленные парсеры, загрузка/очередь, активность прокси-чекеров. */
export function parseInfo(data: any): InstanceInfo {
  const d = data || {};
  const parsers = Array.isArray(d.availableParsers) ? d.availableParsers.map(str) : [];
  return {
    version: d.version != null ? str(d.version) : null,
    parsersCount: parsers.length,
    parsers,
    tasksInQueue: num(d.tasksInQueue),
    workingTasks: num(d.workingTasks),
    activeThreads: num(d.activeThreads),
    activeProxyCheckerThreads: num(d.activeProxyCheckerThreads),
    pid: d.pid != null ? str(d.pid) : null,
  };
}

export interface ProxiesView {
  count: number;
  byType: Record<string, number>;
  proxies: Array<{ address: string; type: string }>;
}

/**
 * Ответ getProxies: `{"ip:port":[type,login,pass]}`. Логин/пароль прокси НЕ выводим
 * (маскируем) — только адрес и тип + разбивка по типам и общий счётчик живых.
 */
export function parseProxies(data: any): ProxiesView {
  const map = data && typeof data === 'object' ? data : {};
  const proxies: Array<{ address: string; type: string }> = [];
  const byType: Record<string, number> = {};
  for (const [address, val] of Object.entries(map)) {
    const type = str(Array.isArray(val) ? val[0] : val);
    proxies.push({ address, type });
    byType[type] = (byType[type] || 0) + 1;
  }
  return { count: proxies.length, byType, proxies };
}

/** Потолок списка прокси в выводе инструмента: count — всегда полный, список обрезан. */
export const PROXIES_CAP = 100;

/** Обрезка списка прокси до cap с флагом truncated (count/byType — полные). */
export function capProxies(view: ProxiesView, cap = PROXIES_CAP): ProxiesView & { truncated: boolean } {
  return { ...view, truncated: view.proxies.length > cap, proxies: view.proxies.slice(0, cap) };
}

/** Ответ getParserInfo: какие поля парсер умеет вернуть ({arrays:{...}, flat:[...]}). */
export function parseParserFields(data: any): { flat: string[]; arrays: string[] } {
  const res = data?.results || {};
  const arrays = res.arrays && typeof res.arrays === 'object' ? Object.keys(res.arrays) : [];
  const flat = Array.isArray(res.flat) ? res.flat.map(str) : [];
  return { flat, arrays };
}
