/** Парсинг XML-ответов XMLStock (формат Yandex.XML + расширения). */
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
  // подсветки приходят вложенным тегом <hlword> — держим эти узлы сырыми строками,
  // иначе парсер разберёт их в объекты и потеряет порядок текста
  stopNodes: ['*.passage', '*.title', '*.question', '*.snippet', '*.extendedpassage'],
});

export function parseXml(xml: string): any {
  return parser.parse(xml);
}

/** Всегда массив (fast-xml-parser отдаёт объект для единственного элемента). */
export function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Извлекает подсветки из строки с <hlword>: последовательные подсвеченные слова
 * («<hlword>купить</hlword> <hlword>квартиру</hlword>») склеиваются в одну фразу.
 */
export function extractBolds(raw: string | undefined): string[] {
  if (!raw) return [];
  // склейка соседних hlword через пробел/дефис
  const merged = String(raw).replace(/<\/hlword>([\s -]{1,3})<hlword>/gi, '$1');
  const bolds: string[] = [];
  const re = /<hlword>(.*?)<\/hlword>/gis;
  let m: RegExpExecArray | null;
  while ((m = re.exec(merged)) !== null) {
    const text = decodeEntities(m[1].replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (text) bolds.push(text);
  }
  return bolds;
}

/** Убирает hlword и прочие теги, отдаёт чистый текст. */
export function stripTags(raw: string | undefined): string {
  if (raw === undefined || raw === null) return '';
  return decodeEntities(
    String(raw)
      .replace(/<\/?hlword>/gi, '')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
