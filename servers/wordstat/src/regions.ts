/** Плоский справочник id→название из дерева регионов Wordstat (getRegionsTree). */
export interface RegionNode {
  id?: string;
  label?: string;
  children?: RegionNode[];
}

/** Обходит дерево регионов и собирает Map<id, название>. */
export function flattenRegions(nodes: RegionNode[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (ns?: RegionNode[]): void => {
    for (const n of ns ?? []) {
      if (n.id != null && n.label != null) map.set(String(n.id), String(n.label));
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return map;
}
