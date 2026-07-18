/**
 * Общий разбор SERP-ответов формата Yandex.XML (используют XMLStock и XMLRiver).
 * Вынесено из серверов в отдельный subpath `@seo-tools/shared/serp`, чтобы
 * fast-xml-parser не попадал в бандлы серверов, которым SERP не нужен.
 */

export { docsOf, passages } from './helpers.js';
export { parseDocs, type SerpDoc } from './parse.js';
export { asArray, domainOf, extractBolds, parseXml, stripTags } from './xml.js';
