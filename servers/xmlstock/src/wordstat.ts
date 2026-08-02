/**
 * Разбор ответов XMLStock Wordstat API (эндпоинт /wordstat/json/, формат JSON).
 * Сверено на живых ответах:
 *  - pagetype=words:       { results:[{phrase,count}], associations:[{phrase,count}], totalCount }
 *  - pagetype=history:     { results:[{date,count,share}] }
 *  - pagetype=regions:     { results:[{region,count,share,affinityIndex}] }
 *  - pagetype=regionsTree: { regions:[{id,label,children[]}] }
 * count/totalCount приходят строками — парсим в number.
 * Здесь же HTTP-слой (wordstatGet), хелпер дат (wsDate), валидация порядка дат
 * и per-account кэш имён регионов — вынесены из index.ts ради юнит-тестов.
 */
import { CostLogger, fetchText, getConfig, requireEnv } from '@seo-tools/shared';

export const WORDSTAT_URL = 'https://xmlstock.com/wordstat/json/';

// Wordstat у XMLStock дороже SERP (~19 ₽/1K против ~12 ₽/1K) — отдельный счётчик расхода;
// цена читается лениво из конфига — set_credentials применяется без перезапуска
const wordstatCost = new CostLogger('xmlstock-wordstat', () => Number(getConfig('XMLSTOCK_WORDSTAT_PRICE_PER_CALL') || 0.019));

/** GET к Wordstat XMLStock: JSON; ошибки приходят как { error: { code, message } }. */
export async function wordstatGet(pagetype: string, params: Record<string, string | number | undefined>, account?: string): Promise<any> {
  const user = requireEnv('XMLSTOCK_USER', account);
  const key = requireEnv('XMLSTOCK_KEY', account);
  const qs = new URLSearchParams({ user, key, pagetype });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const text = await fetchText(`${WORDSTAT_URL}?${qs}`, { timeoutMs: 60_000 });
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      'XMLStock Wordstat вернул не JSON — вероятно неверные XMLSTOCK_USER/XMLSTOCK_KEY (xmlstock_set_credentials / xmlstock_auth_status).',
    );
  }
  const err = json?.error;
  if (err) {
    const code = Number(err?.code ?? 0);
    const message = String(err?.message ?? '');
    if (code === 100 || code === 200 || /key|user|auth|ключ|доступ|access/i.test(message)) {
      throw new Error(`XMLStock Wordstat error ${code}: ${message}. Проверьте XMLSTOCK_USER/XMLSTOCK_KEY (xmlstock_set_credentials).`);
    }
    throw new Error(`XMLStock Wordstat error ${code}: ${message}`);
  }
  wordstatCost.track('wordstat');
  return json;
}

/** Валидация порядка дат dynamics ДО платного запроса (образец — validateDynamicsDates сервера wordstat). */
export function validateWsDateOrder(from: string, to: string): void {
  if (from > to) throw new Error(`from (${from}) позже to (${to}) — поменяй даты местами`);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** YYYY-MM-DD → DD.MM.YYYY. Для period=month снапаем start→01, end→последний день месяца (иначе XMLStock code 7). */
export function wsDate(iso: string, opts?: { startOfMonth?: boolean; endOfMonth?: boolean }): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso; // не наш формат — отдадим как есть, XMLStock сам отвалидирует
  const [, y, mo] = m;
  let d = m[3];
  if (opts?.startOfMonth) d = '01';
  if (opts?.endOfMonth) d = pad2(new Date(Number(y), Number(mo), 0).getDate());
  return `${d}.${mo}.${y}`;
}

/**
 * Per-account кэш дерева регионов (id→имя), TTL 24ч — обогащаем ответ regions именами.
 * Кэшируется и in-flight промис (внутри createRegionNamesCache): параллельные вызовы
 * не плодят лишние платные запросы дерева.
 */
export function createWsRegionNames(fetchTree: (account?: string) => Promise<any>): (account?: string) => Promise<Map<string, string>> {
  const byAccount = new Map<string, ReturnType<typeof createRegionNamesCache>>();
  return (account?: string) => {
    const acc = account || '';
    let loader = byAccount.get(acc);
    if (!loader) {
      loader = createRegionNamesCache(() => fetchTree(account));
      byAccount.set(acc, loader);
    }
    return loader();
  };
}

const num = (v: unknown): number => Number(String(v ?? '').replace(/\s/g, '')) || 0;

export interface WsPhrase {
  phrase: string;
  count: number;
}

export interface WordsResult {
  totalCount: number;
  results: WsPhrase[];
  associations: WsPhrase[];
}

/** pagetype=words: топ запросов по фразе (results) + похожие/ассоциации (associations). */
export function parseWords(json: any): WordsResult {
  const map = (a: any): WsPhrase[] =>
    (Array.isArray(a) ? a : []).map((x) => ({ phrase: String(x?.phrase ?? ''), count: num(x?.count) })).filter((p) => p.phrase);
  return {
    totalCount: num(json?.totalCount),
    results: map(json?.results),
    associations: map(json?.associations),
  };
}

export interface HistPoint {
  date: string;
  count: number;
  share: number;
}

/** pagetype=history: динамика частотности по датам. */
export function parseHistory(json: any): HistPoint[] {
  return (Array.isArray(json?.results) ? json.results : []).map((x: any) => ({
    date: String(x?.date ?? ''),
    count: num(x?.count),
    share: Number(x?.share) || 0,
  }));
}

export interface RegionStat {
  regionId: string;
  name: string | null;
  count: number;
  share: number;
  affinityIndex: number;
}

/** pagetype=regions: распределение по регионам; имена подставляются из дерева регионов. */
export function parseRegions(json: any, names?: Map<string, string>): RegionStat[] {
  return (Array.isArray(json?.results) ? json.results : []).map((x: any) => {
    const id = String(x?.region ?? '');
    return {
      regionId: id,
      name: names?.get(id) ?? null,
      count: num(x?.count),
      share: Number(x?.share) || 0,
      affinityIndex: Number(x?.affinityIndex) || 0,
    };
  });
}

export interface RegionNode {
  id: string;
  name: string;
  path: string;
}

/** pagetype=regionsTree: разворачивает дерево регионов ({id,label,children}) в плоский список. */
export function flattenRegionsTree(json: any): RegionNode[] {
  const out: RegionNode[] = [];
  const walk = (nodes: any, parents: string[]): void => {
    for (const n of Array.isArray(nodes) ? nodes : []) {
      const id = String(n?.id ?? '');
      const name = String(n?.label ?? '');
      if (id) out.push({ id, name, path: [...parents, name].filter(Boolean).join(' / ') });
      if (n?.children) walk(n.children, [...parents, name]);
    }
  };
  walk(json?.regions, []);
  return out;
}

/** id региона → имя (для обогащения ответа regions). */
export function regionNameMap(json: any): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of flattenRegionsTree(json)) m.set(r.id, r.name);
  return m;
}

/**
 * Кэш дерева регионов с дедупликацией in-flight запроса: без него два параллельных
 * вызова при холодном кэше уходят в два ПЛАТНЫХ запроса regionsTree. Кэшируем промис,
 * а не только результат; по TTL кэш перечитывается.
 */
export function createRegionNamesCache(fetchTree: () => Promise<any>, ttlMs = 24 * 60 * 60 * 1000): () => Promise<Map<string, string>> {
  let cached: { names: Map<string, string>; ts: number } | null = null;
  let inflight: Promise<Map<string, string>> | null = null;
  return async () => {
    if (cached && Date.now() - cached.ts < ttlMs) return cached.names;
    if (inflight) return inflight;
    inflight = fetchTree()
      .then((json) => {
        const names = regionNameMap(json);
        cached = { names, ts: Date.now() };
        return names;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
