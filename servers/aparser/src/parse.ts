/**
 * Чистые парсеры ответов A-Parser API (без сети — покрыты юнит-тестами).
 *
 * Формы ответов сверены по докам a-parser.com/docs/en/api/methods и офиц. PHP-клиенту.
 * Доступ к полям намеренно защитный (несколько алиасов на ключ): точные имена
 * полей serp[] у SE::Google/SE::Yandex подтверждаются на живом инстансе — при
 * расхождении правится только маппинг здесь, интерфейс инструментов не меняется.
 */

/** Число из строки/значения: терпит пробелы-разделители («132 584»), иначе 0. */
export const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(/\s+/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const str = (v: unknown): string => (v == null ? '' : String(v));

/** Первое непустое значение по списку ключей-алиасов. */
const pick = (o: any, keys: string[]): unknown => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) {
    if (o[k] != null && o[k] !== '') return o[k];
  }
  return undefined;
};

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
  totalcount: number | null;
  misspell: string | null;
  count: number;
  serp: SerpItem[];
  related: string[];
  ads: SerpItem[];
}

/** Нормализует один result-объект oneRequest/bulkRequest в стабильную SERP-форму. */
export function parseSerpResult(result: any): SerpResult {
  const r = result || {};
  const serp = Array.isArray(r.serp) ? r.serp : [];
  const related = Array.isArray(r.related) ? r.related : [];
  const ads = Array.isArray(r.ads) ? r.ads : [];
  return {
    query: str(r.query),
    success: r.success !== false && r.success !== 0,
    totalcount: num(pick(r, ['totalcount', 'totalCount'])) || null,
    misspell: r.misspell ? str(r.misspell) : null,
    count: serp.length,
    serp: serp.map(normSerpItem),
    related: related.map((x: any) => str(typeof x === 'string' ? x : pick(x, ['anchor', 'keyword', 'query', 'text']))).filter(Boolean),
    ads: ads.map(normSerpItem),
  };
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

/** Подсказки из suggest-парсера (SE::*::Suggest): терпит suggest[]/suggestions[]/serp[]. */
export function parseSuggest(result: any): string[] {
  const r = result || {};
  const raw = Array.isArray(r.suggest) ? r.suggest : Array.isArray(r.suggestions) ? r.suggestions : Array.isArray(r.serp) ? r.serp : [];
  return raw.map((x: any) => str(typeof x === 'string' ? x : pick(x, ['suggest', 'anchor', 'keyword', 'text', 'link']))).filter(Boolean);
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

/** Ответ getParserInfo: какие поля парсер умеет вернуть ({arrays:{...}, flat:[...]}). */
export function parseParserFields(data: any): { flat: string[]; arrays: string[] } {
  const res = data && data.results ? data.results : {};
  const arrays = res.arrays && typeof res.arrays === 'object' ? Object.keys(res.arrays) : [];
  const flat = Array.isArray(res.flat) ? res.flat.map(str) : [];
  return { flat, arrays };
}
