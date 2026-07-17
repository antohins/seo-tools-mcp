/** Разбор вертикалей Google (images/news/video) XMLStock — структуры сверены на живых ответах. */
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

export interface ImageResult {
  position: number;
  url: string;
  imageUrl: string;
  title: string;
}

export interface NewsResult {
  position: number;
  url: string;
  title: string;
  source: string;
  date: string;
  snippet: string;
}

export interface VideoResult {
  position: number;
  url: string;
  title: string;
  thumbnail: string;
  host: string;
  channel: string;
  duration: string;
  snippet: string;
}

/** tbm=images: url (страница), imgurl (картинка), title. */
export function parseImages(doc: any): ImageResult[] {
  return docsOf(doc)
    .map((d, i) => ({
      position: i + 1,
      url: String(d?.url ?? ''),
      imageUrl: String(d?.imgurl ?? ''),
      title: stripTags(String(d?.title ?? '')),
    }))
    .filter((r) => r.url || r.imageUrl);
}

/** tbm=news: url, title, media (источник), pubDate (дата, часто относительная). */
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

/** tbm=video: url — объект { #text, @_host, @_chanel, @_duration }; imgurl (превью), title, passages. */
export function parseVideo(doc: any): VideoResult[] {
  return docsOf(doc)
    .map((d, i) => {
      const u = d?.url;
      const isObj = u !== null && typeof u === 'object';
      return {
        position: i + 1,
        url: isObj ? String(u['#text'] ?? '') : String(u ?? ''),
        title: stripTags(String(d?.title ?? '')),
        thumbnail: String(d?.imgurl ?? ''),
        host: isObj ? String(u['@_host'] ?? '') : '',
        channel: isObj ? String(u['@_chanel'] ?? '') : '', // @_chanel — опечатка в API
        duration: isObj ? String(u['@_duration'] ?? '') : '',
        snippet: passages(d),
      };
    })
    .filter((r) => r.url);
}
