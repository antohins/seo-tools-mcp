/**
 * Поиск заведений по Google Maps через XMLRiver (setab=maps) — вынесен из index.ts ради юнит-тестов.
 * Формат ответа — по доке https://xmlriver.com/apidoc/api-maps/:
 * <response><found/><maps><item> с полями title, stars, type, address, url, phone, review,
 * possibility, latitude, longitude, placeid, countreviews, accessibility, price, gasprice.
 * ВАЖНО: формат по доке, лайвом НЕ подтверждён — на тестовом аккаунте (user=7691, 2026-08)
 * эндпоинт стабильно отвечает кодом 500 (обычный SERP при этом работает): вероятно,
 * требуется платная опция кабинета XMLRiver или фича недоступна. Парсинг строго защитный:
 * любое отсутствующее/пустое поле → undefined, битые item-ы отбрасываются.
 *
 * Параметры запроса (по доке): zoom (1–15) и coords (lat,lng) — обязательные;
 * count (5–50) и lr — опциональные. Код 15 — пустая выдача (тарифицируется, empty: true).
 * HTTP-ретраи/коды/учёт расхода — общие, в xmlriverGet из ./serp.js.
 */
import { asArray, stripTags } from '@seo-tools/shared/serp';
import { z } from 'zod';
import { extractFound, GOOGLE_URL, isEmptySerp, resolveLr, xmlriverGet } from './serp.js';

/** coords API XMLRiver: «широта,долгота» (знак и дробная часть опциональны). */
export const mapsCoordsSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/, 'coords — формат «широта,долгота», например «51.5468,45.9968»');

export interface MapPlace {
  /** название заведения */
  title: string;
  /** рейтинг (в XML «4,7» — десятичная запятая → 4.7) */
  stars?: number;
  /** категория («Кафе») */
  type?: string;
  address?: string;
  /** сайт заведения (в доке часто пустой) */
  url?: string;
  phone?: string;
  /** текст отзыва */
  review?: string;
  /** сервисы заведения (поле possibility «Еда в заведении ⋅ Доставка» → массив) */
  features?: string[];
  lat: number;
  lng: number;
  place_id?: string;
  reviews_count?: number;
  /** доступность для маломобильных (в XML — «true»/«false») */
  accessibility?: boolean;
  /** ценовая категория */
  price?: string;
}

export interface MapsResult {
  places: MapPlace[];
  count: number;
  /** <found priority="all"> — всего найдено (null, если поля нет) */
  found: number | null;
  /** true — код 15: пустая выдача, запрос при этом тарифицирован */
  empty?: true;
  note?: string;
}

const numOr = (v: unknown): number | undefined => {
  // у XMLRiver десятичный разделитель — запятая («4,7»); пустая строка → undefined (Number('') === 0!)
  const s = String(v ?? '')
    .trim()
    .replace(',', '.');
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

const strOr = (v: unknown): string | undefined => {
  const s = stripTags(String(v ?? ''));
  return s || undefined;
};

/**
 * Разбор response/maps/item[]. Строго защитный: item без title и без валидных
 * координат отбрасывается; пустые строки/нечисловые значения → поле отсутствует.
 */
export function parseMaps(doc: any): MapPlace[] {
  const items = asArray<any>(doc?.yandexsearch?.response?.maps?.item);
  const places: MapPlace[] = [];
  for (const it of items) {
    const title = strOr(it?.title);
    const lat = numOr(it?.latitude);
    const lng = numOr(it?.longitude);
    // item без названия и без координат — мусор, пропускаем
    if (!title && (lat === undefined || lng === undefined)) continue;
    const place: MapPlace = { title: title ?? '', lat: lat ?? 0, lng: lng ?? 0 };
    const stars = numOr(it?.stars);
    if (stars !== undefined) place.stars = stars;
    const type = strOr(it?.type);
    if (type) place.type = type;
    const address = strOr(it?.address);
    if (address) place.address = address;
    const url = strOr(it?.url);
    if (url) place.url = url;
    const phone = strOr(it?.phone);
    if (phone) place.phone = phone;
    const review = strOr(it?.review);
    if (review) place.review = review;
    // possibility — «Еда в заведении ⋅ Заказ с улицы ⋅ Доставка» → features
    const features = strOr(it?.possibility)
      ?.split('⋅')
      .map((s) => s.trim())
      .filter(Boolean);
    if (features?.length) place.features = features;
    const placeId = strOr(it?.placeid);
    if (placeId) place.place_id = placeId;
    const reviews = numOr(it?.countreviews);
    if (reviews !== undefined) place.reviews_count = reviews;
    const accessibility = strOr(it?.accessibility);
    if (accessibility === 'true' || accessibility === 'false') place.accessibility = accessibility === 'true';
    const price = strOr(it?.price);
    if (price) place.price = price;
    places.push(place);
  }
  return places;
}

/**
 * Один GET setab=maps (пагинации у эндпоинта нет — объём регулируется count).
 * Код 15 → empty: true, запрос тарифицирован (списание трекает xmlriverGet).
 */
export async function collectMaps(
  query: string,
  coords: string,
  zoom: number,
  count: number,
  region?: string,
  account?: string,
): Promise<MapsResult> {
  const params: Record<string, string | number | undefined> = { setab: 'maps', query, coords, zoom, count };
  const lr = resolveLr(region);
  if (lr !== undefined) params.lr = lr;

  const doc = await xmlriverGet(GOOGLE_URL, params, account);
  if (isEmptySerp(doc)) {
    return { places: [], count: 0, found: extractFound(doc), empty: true, note: 'пустая выдача (код 15), запрос тарифицирован' };
  }
  const places = parseMaps(doc);
  return { places, count: places.length, found: extractFound(doc) };
}
