/**
 * Дополнительные SERP-блоки Google через параметр additional= (xmlriver_serp).
 * Нюансы, сверенные на живых ответах (2026-08, user=7691) и доке xmlriver.com/apidoc:
 *  - значение — список блоков через запятую (knowledge_graph,localresultsplace,rs,...),
 *    работает только для engine=google (у Яндекса свой additional, вне скоупа);
 *  - блоки приходят внутри <response><addresults>...; наполнение зависит от ПЛАТНЫХ
 *    опций кабинета XMLRiver («Платные дополнительные параметры») и наличия блока в выдаче:
 *    на тестовом аккаунте knowledge_graph пришёл с ПУСТЫМИ полями, localresultsplace/rs/
 *    g_discuss/faqsnippet не пришли вовсе. Поэтому парсим всё, что пришло; пустые блоки
 *    помечаем empty, не пришедшие — перечисляем в unavailable;
 *  - <knowledge_graph> — плоский набор полей (type firm/person, place_id, name, rating,
 *    countReviews, address, phone, website, category, wiki, birthdate, birthplace,
 *    description, timework, pricecategory), <point lat lng>, reviews/item (link+rating),
 *    upComingEvents/event;
 *  - <localresultsplace><item> — title, place_id, url, rating, thumbnail;
 *  - <relatedSearches><query><title> — связанные запросы (по доке; лайвом не пришёл);
 *  - <faqsnippet> — структура по доке api-faq (вопрос/ответ); лайвом не подтверждена,
 *    парсим по разумной схеме item/{question,answer,url};
 *  - остальные запрошенные блоки (структура не задокументирована/не проверена) —
 *    фиксируем только факт присутствия { present: true }, не роняя инструмент.
 * Ключи ответа нормализованы в snake_case: countReviews → reviews_count,
 * timework → working_hours, pricecategory → price_category, upComingEvents → events.
 */
import { asArray, decodeEntities, stripTags } from '@seo-tools/shared/serp';

/** Значения параметра additional= по доке XMLRiver (только Google). */
export const ADDITIONAL_PARAMS = [
  'knowledge_graph',
  'localresultsplace',
  'rs',
  'faqsnippet',
  'g_discuss',
  'es',
  'sitelinks',
  'oneline_sitelinks',
  'google_first_position',
  'cachelink',
  'topads',
  'bottomads',
  'g_inlineshopping',
  'g_podcasts',
  'g_news',
  'g_videos',
  'app',
] as const;

export type AdditionalParam = (typeof ADDITIONAL_PARAMS)[number];

// имя XML-элемента внутри <addresults> для запрошенного блока (по умолчанию совпадает)
const ELEMENT_NAME: Partial<Record<AdditionalParam, string>> = {
  rs: 'relatedSearches',
};

/** Непустая строка или undefined (пустые поля блоков честно выкидываем; entities декодируем — title/question приходят stopNode-сырьём). */
function str(v: unknown): string | undefined {
  // title/question приходят stopNode'ами (сырой XML с дочерними тегами) — снимаем разметку,
  // как это делает maps.ts (иначе «Cafe <b>Nero</b>» протекает в вывод).
  const s = typeof v === 'string' ? stripTags(decodeEntities(v)).trim() : typeof v === 'number' ? String(v) : '';
  return s || undefined;
}

/** Число или undefined (терпим десятичную запятую). */
function num(v: unknown): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

export interface KnowledgeGraph {
  /** блок <knowledge_graph> пришёл в ответе */
  present: true;
  /** true — блок пришёл, но все поля пустые (опция кабинета не включена / нет данных) */
  empty?: boolean;
  /** firm | person */
  type?: string;
  place_id?: string;
  name?: string;
  rating?: number;
  /** countReviews */
  reviews_count?: number;
  address?: string;
  phone?: string;
  website?: string;
  category?: string;
  wiki?: string;
  birthdate?: string;
  birthplace?: string;
  description?: string;
  /** timework */
  working_hours?: string;
  /** pricecategory */
  price_category?: string;
  /** <point lat lng> */
  coordinates?: { lat: number; lng: number };
  /** reviews/item: ссылка на отзыв + его оценка */
  reviews?: { link?: string; rating?: number }[];
  /** upComingEvents/event: поля событий отдаём как есть (плоские скаляры) */
  events?: Record<string, string>[];
}

// плоские строковые поля KG: [xml-имя, ключ ответа]
const KG_SCALAR_FIELDS: [string, keyof KnowledgeGraph][] = [
  ['type', 'type'],
  ['place_id', 'place_id'],
  ['name', 'name'],
  ['address', 'address'],
  ['phone', 'phone'],
  ['website', 'website'],
  ['category', 'category'],
  ['wiki', 'wiki'],
  ['birthdate', 'birthdate'],
  ['birthplace', 'birthplace'],
  ['description', 'description'],
  ['timework', 'working_hours'],
  ['pricecategory', 'price_category'],
];

/** Плоские скалярные поля произвольного узла (для upComingEvents/event: структура не зафиксирована). */
function scalarFields(node: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith('@_')) continue; // атрибуты пропускаем
    const s = str(v);
    if (s) out[k] = s;
  }
  return out;
}

/** Разбор <knowledge_graph>: пустые поля → undefined; полностью пустой блок → empty: true. */
export function parseKnowledgeGraph(node: any): KnowledgeGraph {
  const kg: KnowledgeGraph = { present: true };
  if (node && typeof node === 'object') {
    for (const [xmlName, key] of KG_SCALAR_FIELDS) {
      const s = str(node[xmlName]);
      if (s) (kg as any)[key] = s;
    }
    const rating = num(node.rating);
    if (rating !== undefined) kg.rating = rating;
    const reviewsCount = num(node.countReviews);
    if (reviewsCount !== undefined) kg.reviews_count = reviewsCount;

    // <point lat="55.75" lng="37.61"/> — атрибуты, после парсера '@_lat'/'@_lng'
    const point = node.point;
    if (point && typeof point === 'object') {
      const lat = num(point['@_lat']);
      const lng = num(point['@_lng']);
      if (lat !== undefined && lng !== undefined) kg.coordinates = { lat, lng };
    }

    const reviews = asArray<any>(node.reviews?.item)
      .map((it) => ({ link: str(it?.link), rating: num(it?.rating) }))
      .filter((it) => it.link || it.rating !== undefined)
      .map((it) => ({ ...(it.link ? { link: it.link } : {}), ...(it.rating !== undefined ? { rating: it.rating } : {}) }));
    if (reviews.length) kg.reviews = reviews;

    const events = asArray<any>(node.upComingEvents?.event)
      .map((ev) => scalarFields(ev))
      .filter((ev) => Object.keys(ev).length > 0);
    if (events.length) kg.events = events;
  }
  if (Object.keys(kg).length === 1) kg.empty = true; // только present — все поля пустые
  return kg;
}

export interface LocalPlace {
  title?: string;
  place_id?: string;
  url?: string;
  rating?: number;
  thumbnail?: string;
}

/** Разбор <localresultsplace><item> — карточки локальной выдачи Google Maps. */
export function parseLocalResults(node: any): LocalPlace[] {
  return asArray<any>(node?.item)
    .map((it) => {
      const place: LocalPlace = {};
      const title = str(it?.title);
      if (title) place.title = title;
      const placeId = str(it?.place_id);
      if (placeId) place.place_id = placeId;
      const url = str(it?.url);
      if (url) place.url = url;
      const rating = num(it?.rating);
      if (rating !== undefined) place.rating = rating;
      const thumbnail = str(it?.thumbnail);
      if (thumbnail) place.thumbnail = thumbnail;
      return place;
    })
    .filter((p) => Object.keys(p).length > 0);
}

/** Разбор <relatedSearches><query><title> — список связанных запросов. */
export function parseRelatedSearches(node: any): string[] {
  return asArray<any>(node?.query)
    .map((q) => str(q?.title) ?? str(q))
    .filter((s): s is string => Boolean(s));
}

export interface FaqItem {
  question?: string;
  answer?: string;
  url?: string;
}

/**
 * Разбор <faqsnippet> (структура по доке, лайвом блок не пришёл): item/{question,answer,url}.
 * Пустые item отбрасываются.
 */
export function parseFaqSnippet(node: any): FaqItem[] {
  return asArray<any>(node?.item)
    .map((it) => {
      const item: FaqItem = {};
      const question = str(it?.question);
      if (question) item.question = question;
      const answer = str(it?.answer);
      if (answer) item.answer = answer;
      const url = str(it?.url);
      if (url) item.url = url;
      return item;
    })
    .filter((f) => Object.keys(f).length > 0);
}

/**
 * Секция additional ответа: разобранные блоки + unavailable (запрошенные, но не пришедшие).
 * Блоки с неизвестной структурой — { present: true }. Пришедший, но пустой блок —
 * { present: true, empty: true } (единообразно для всех разобранных блоков; непустые
 * local_results/related_searches/faq — массивы). Неизвестные элементы <addresults>,
 * которых не запрашивали, игнорируются.
 */
export type AdditionalSection = Record<string, unknown> & { unavailable?: string[] };

/**
 * Разбор <response><addresults>: для каждого запрошенного блока — парсинг или флаг
 * присутствия; отсутствующие элементы — в unavailable. Пустой элемент (<knowledge_graph/>)
 * считается пришедшим, но пустым. Никогда не бросает исключений на мусорных данных.
 */
export function parseAddResults(doc: any, requested: AdditionalParam[]): AdditionalSection {
  const add = doc?.yandexsearch?.response?.addresults;
  const out: AdditionalSection = {};
  const unavailable: string[] = [];
  for (const name of new Set(requested)) {
    const elName = ELEMENT_NAME[name] ?? name;
    const node = add && typeof add === 'object' ? add[elName] : undefined;
    // undefined/null — блока нет в ответе; '' — элемент пришёл, но пустой
    if (node === undefined || node === null) {
      unavailable.push(name);
      continue;
    }
    switch (name) {
      case 'knowledge_graph':
        out.knowledge_graph = parseKnowledgeGraph(node);
        break;
      case 'localresultsplace': {
        // единообразие с KG: пришедший, но пустой блок — { present, empty }, а не []
        const items = parseLocalResults(node);
        out.local_results = items.length ? items : { present: true, empty: true };
        break;
      }
      case 'rs': {
        const items = parseRelatedSearches(node);
        out.related_searches = items.length ? items : { present: true, empty: true };
        break;
      }
      case 'faqsnippet': {
        const items = parseFaqSnippet(node);
        out.faq = items.length ? items : { present: true, empty: true };
        break;
      }
      default:
        out[name] = { present: true };
    }
  }
  if (unavailable.length) out.unavailable = unavailable;
  return out;
}
