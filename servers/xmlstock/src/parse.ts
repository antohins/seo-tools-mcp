/** Разбор органической выдачи XMLStock — вынесено из index.ts для тестируемости. */
import { asArray, extractBolds, stripTags, domainOf } from './xml.js';

export interface SerpDoc {
  position: number;
  url: string;
  domain: string;
  title: string;
  snippet: string;
  text_bolds: string[];
  is_featured: boolean;
  type: 'organic' | 'featured' | 'ad';
  contenttype?: string;
  site_name?: string;
  pubDate?: string;
  breadcrumbs?: string;
}

/**
 * Собирает органические результаты, типы SERP-фич (packs) и ситилинки топ-1.
 * Не-организм (contenttype ≠ organic/unknown_onebox) уходит в packs (даже без url);
 * организм с битым/пустым url отбрасывается до domainOf.
 */
export function parseDocs(doc: any): { docs: SerpDoc[]; packs: string[]; sitelinksTop1: string[] } {
  const groups = asArray(doc?.yandexsearch?.response?.results?.grouping?.group);
  const docs: SerpDoc[] = [];
  const packs = new Set<string>();
  let sitelinksTop1: string[] = [];
  let position = 0;

  for (const g of groups) {
    for (const d of asArray<any>(g?.doc)) {
      const contenttype = String(d?.contenttype ?? 'organic');
      if (contenttype !== 'organic' && contenttype !== 'unknown_onebox') {
        packs.add(contenttype); // SERP-фича считается даже без url
        continue;
      }
      const url = String(d?.url ?? '');
      if (!url.startsWith('http')) continue; // битый/пустой организм-doc — отбрасываем до domainOf
      const rawTitle = String(d?.title ?? '');
      const rawPassages = asArray<any>(d?.passages?.passage).map((p) => String(p ?? '')).join(' … ');
      position += 1;
      const item: SerpDoc = {
        position,
        url,
        domain: domainOf(url),
        title: stripTags(rawTitle),
        snippet: stripTags(rawPassages),
        text_bolds: [...new Set([...extractBolds(rawTitle), ...extractBolds(rawPassages)])],
        is_featured: false,
        type: 'organic',
        contenttype,
      };
      if (d?.site_name) item.site_name = stripTags(String(d.site_name));
      if (d?.pubDate) item.pubDate = stripTags(String(d.pubDate));
      if (d?.breadcrumbs) item.breadcrumbs = stripTags(String(d.breadcrumbs));
      docs.push(item);
      if (position === 1) {
        sitelinksTop1 = asArray<any>(d?.sitelinks?.sitelink ?? d?.oneline_sitelinks?.sitelink)
          .map((s) => stripTags(String(s?.title ?? '')))
          .filter(Boolean);
      }
    }
  }
  return { docs, packs: [...packs], sitelinksTop1 };
}
