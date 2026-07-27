/**
 * Разбор ответов XMLStock Wordstat API (эндпоинт /wordstat/json/, формат JSON).
 * Сверено на живых ответах:
 *  - pagetype=words:       { results:[{phrase,count}], associations:[{phrase,count}], totalCount }
 *  - pagetype=history:     { results:[{date,count,share}] }
 *  - pagetype=regions:     { results:[{region,count,share,affinityIndex}] }
 *  - pagetype=regionsTree: { regions:[{id,label,children[]}] }
 * count/totalCount приходят строками — парсим в number.
 */

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
