/**
 * Единый справочник регионов Яндекса (lr / Wordstat regions) для всех серверов —
 * НЕ дублировать по серверам, расширять только здесь.
 * XMLStock маппит эти же id и на Google.
 */
export const YANDEX_REGIONS: Record<string, number> = {
  'россия': 225,
  'москва': 213,
  'москва и область': 1,
  'санкт-петербург': 2,
  'екатеринбург': 54,
  'новосибирск': 65,
  'краснодар': 35,
  'казань': 43,
  'беларусь': 149,
  'казахстан': 159,
};

function resolveOne(part: string): string {
  const p = part.trim();
  if (/^\d+$/.test(p)) return p;
  const id = YANDEX_REGIONS[p.toLowerCase()];
  if (id === undefined) {
    throw new Error(
      `Неизвестный регион «${p}» — передай числовой id региона Яндекса ` +
      `или одно из: ${Object.keys(YANDEX_REGIONS).join(', ')}`,
    );
  }
  return String(id);
}

/** «Москва, Санкт-Петербург» / «213,2» → ['213','2']; undefined → undefined (все регионы). */
export function resolveRegionIds(region?: string): string[] | undefined {
  if (!region) return undefined;
  return region.split(',').map(resolveOne);
}

/** Один регион (первый из списка) числом — для API, принимающих единственный lr. */
export function resolveRegionId(region?: string): number | undefined {
  const ids = resolveRegionIds(region);
  return ids ? Number(ids[0]) : undefined;
}
