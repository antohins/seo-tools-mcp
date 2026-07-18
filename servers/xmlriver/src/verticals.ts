/** Разбор вертикалей Google (images/news) XMLRiver — структуры сверены на живых ответах. */
import { asArray, stripTags } from './xml.js';

function docsOf(doc: any): any[] {
  const out: any[] = [];
  for (const g of asArray(doc?.yandexsearch?.response?.results?.grouping?.group)) {
    for (const d of asArray<any>(g?.doc)) out.push(d);
  }
  return out;
}

const passages = (d: any): string =>
  stripTags(
    asArray<any>(d?.passages?.passage)
      .map((p) => String(p ?? ''))
      .join(' … '),
  );

const num = (v: unknown): number | undefined => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

export interface ImageResult {
  position: number;
  url: string;
  imageUrl: string;
  title: string;
  source?: string;
  width?: number;
  height?: number;
}

export interface NewsResult {
  position: number;
  url: string;
  title: string;
  source: string;
  date: string;
  snippet: string;
}

/** setab=images: url (страница), imgurl (картинка), title, displaylink (источник), originalwidth/height. */
export function parseImages(doc: any): ImageResult[] {
  return docsOf(doc)
    .map((d, i) => {
      const r: ImageResult = {
        position: i + 1,
        url: String(d?.url ?? ''),
        imageUrl: String(d?.imgurl ?? ''),
        title: stripTags(String(d?.title ?? '')),
      };
      const source = stripTags(String(d?.displaylink ?? ''));
      if (source) r.source = source;
      const w = num(d?.originalwidth);
      const h = num(d?.originalheight);
      if (w) r.width = w;
      if (h) r.height = h;
      return r;
    })
    .filter((r) => r.url || r.imageUrl);
}

/** setab=news: url, title, media (источник), pubDate (дата, часто относительная), passages. */
export function parseNews(doc: any): NewsResult[] {
  return docsOf(doc)
    .map((d, i) => ({
      position: i + 1,
      url: String(d?.url ?? ''),
      title: stripTags(String(d?.title ?? '')),
      source: stripTags(String(d?.media ?? '')),
      date: stripTags(String(d?.pubDate ?? '')),
      snippet: passages(d),
    }))
    .filter((r) => r.url);
}
