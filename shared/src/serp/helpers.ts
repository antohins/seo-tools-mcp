/** Общие хелперы разбора вертикалей Google (images/news/video) поверх Yandex.XML. */
import { asArray, stripTags } from './xml.js';

/** Плоский список doc-ов из всех групп ответа. */
export function docsOf(doc: any): any[] {
  const out: any[] = [];
  for (const g of asArray(doc?.yandexsearch?.response?.results?.grouping?.group)) {
    for (const d of asArray<any>(g?.doc)) out.push(d);
  }
  return out;
}

/** Склейка пассажей документа в один сниппет. */
export const passages = (d: any): string =>
  stripTags(
    asArray<any>(d?.passages?.passage)
      .map((p) => String(p ?? ''))
      .join(' … '),
  );
