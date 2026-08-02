/**
 * Чистая логика ywm-сервера (Яндекс.Вебмастер API v4):
 * HTTP-слой с классификацией ошибок (403/404), резолв hostId и user_id
 * (кэш + дедупликация in-flight), пагинация query-analytics и search-queries/popular,
 * агрегация дневной статистики, диапазоны дат (МСК) и фильтр «рекомендованных» запросов.
 * Вынесено из index.ts для юнит-тестов (index.ts поднимает сервер — в тестах его не импортировать).
 */
import { getConfig, HttpError, yandexFetchJson } from '@seo-tools/shared';

export const BASE = 'https://api.webmaster.yandex.net/v4';
const TOKEN_ENV = 'YWM_OAUTH_TOKEN';

/** Сколько строк максимум тянем для честной сортировки топа (6 API-страниц по 500). */
export const SORT_FETCH_CAP = 3000;

/** Классификация ошибок API: 403 — доступ/scope, 404 — хост не найден. */
function classifyError(e: unknown): never {
  if (e instanceof HttpError) {
    if (e.status === 403) {
      throw new Error(
        `${e.message} — нет доступа к хосту или токен без scope «Яндекс.Вебмастер»: ` +
          'проверь hostId (список — ywm_hosts) и переавторизуйся (ywm_oauth_start).',
      );
    }
    if (e.status === 404) {
      throw new Error(`${e.message} — хост не найден: проверь формат hostId (https:example.com:443), список хостов — ywm_hosts.`);
    }
  }
  throw e;
}

export function ywmGet<T = any>(path: string, account?: string): Promise<T> {
  return yandexFetchJson<T>(TOKEN_ENV, `${BASE}${path}`, {}, account, 'ywm').catch(classifyError);
}

export function ywmPost<T = any>(path: string, body: unknown, account?: string): Promise<T> {
  return yandexFetchJson<T>(
    TOKEN_ENV,
    `${BASE}${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    account,
    'ywm',
  ).catch(classifyError);
}

const HOST_ID_RE = /^https?:.+:\d+$/;

/** Хост: явный аргумент или YWM_HOST_ID (с суффиксом профиля) из конфига; формат валидируется. */
export function resolveHost(hostId?: string, account?: string): string {
  const host = hostId || getConfig('YWM_HOST_ID', account);
  if (!host) {
    throw new Error(
      `Не указан хост Вебмастера${account ? ` для аккаунта «${account}»` : ''}: передай hostId (формат https:example.com:443) ` +
        'или сохрани дефолт через ywm_set_credentials' +
        (account ? ` (account="${account}")` : ' (YWM_HOST_ID)') +
        '. Список хостов — ywm_hosts.',
    );
  }
  if (!HOST_ID_RE.test(host)) {
    throw new Error(
      `Некорректный hostId «${host}»: ожидается формат https:example.com:443 (протокол + хост + порт, без слэшей). ` +
        'Список хостов — ywm_hosts.',
    );
  }
  return host;
}

// user_id переживает refresh токена — кэшируем; in-flight промис дедуплицирует параллельные вызовы
// (образец — createRegionNamesCache в wordstat). Ошибки НЕ кэшируются.
const cachedUsers = new Map<string, string>(); // account ?? '' → user_id
const inflightUsers = new Map<string, Promise<string>>();

/** Сброс кэша user_id (после смены токена через auth-инструменты; в тестах — для холодного кэша). */
export function clearUserIdCache(): void {
  cachedUsers.clear();
}

export function getUserId(account?: string): Promise<string> {
  const pinned = getConfig('YWM_USER_ID', account);
  if (pinned) return Promise.resolve(pinned);
  const cacheKey = account ?? '';
  const hit = cachedUsers.get(cacheKey);
  if (hit) return Promise.resolve(hit);
  const inflight = inflightUsers.get(cacheKey);
  if (inflight) return inflight;
  const p = (async () => {
    const data = await ywmGet<{ user_id?: unknown }>('/user/', account);
    const id = data.user_id;
    if (typeof id === 'number' && Number.isFinite(id)) return String(id);
    if (typeof id === 'string' && /^\d+$/.test(id)) return id;
    throw new Error(
      `Неожиданный ответ /user/ Вебмастера: user_id=${JSON.stringify(id)} — ` +
        'проверь токен (ywm_auth_status) или переавторизуйся (ywm_oauth_start).',
    );
  })()
    .then((id) => {
      cachedUsers.set(cacheKey, id);
      return id;
    })
    .finally(() => {
      if (inflightUsers.get(cacheKey) === p) inflightUsers.delete(cacheKey);
    });
  inflightUsers.set(cacheKey, p);
  return p;
}

export interface QaTextStat {
  text_indicator?: { type: string; value: string };
  statistics?: Array<{ date: string; field: string; value: number }>;
}

/**
 * POST query-analytics/list c пагинацией (limit API — 500 за страницу).
 * maxRows может быть функцией от count — чтобы после первой страницы решить,
 * сколько тянуть (например «всё до SORT_FETCH_CAP» для честной сортировки топа).
 */
export async function queryAnalytics(
  hostId: string,
  body: Record<string, unknown>,
  maxRows: number | ((count: number) => number),
  account?: string,
): Promise<{ count: number; items: QaTextStat[] }> {
  const userId = await getUserId(account);
  const path = `/user/${userId}/hosts/${encodeURIComponent(hostId)}/query-analytics/list`;
  const items: QaTextStat[] = [];
  let offset = 0;
  let count = 0;
  let target = typeof maxRows === 'number' ? maxRows : 500; // до первой страницы count неизвестен

  while (items.length < target) {
    const limit = Math.min(500, target - items.length);
    const page = await ywmPost<{ count: number; text_indicator_to_statistics: QaTextStat[] }>(path, { ...body, offset, limit }, account);
    count = page.count ?? 0;
    if (typeof maxRows === 'function') target = maxRows(count);
    const batch = page.text_indicator_to_statistics ?? [];
    items.push(...batch);
    if (!batch.length || items.length >= count) break;
    offset += batch.length;
  }
  return { count, items };
}

export interface QueryRow {
  query: string;
  shows: number;
  clicks: number;
  ctr: number;
  position: number | null;
  demand: number;
}

/** Сворачивает дневные statistics в агрегаты по запросу. */
export function aggregate(stats: NonNullable<QaTextStat['statistics']>) {
  let shows = 0;
  let clicks = 0;
  let demand = 0;
  const posValues: number[] = [];
  for (const s of stats) {
    switch (s.field) {
      case 'IMPRESSIONS':
        shows += s.value;
        break;
      case 'CLICKS':
        clicks += s.value;
        break;
      case 'DEMAND':
        demand += s.value;
        break;
      case 'POSITION':
        posValues.push(s.value);
        break;
    }
  }
  // позиция: простое среднее по дням (повзвесить на показы построчно API не даёт)
  const position = posValues.length ? posValues.reduce((a, b) => a + b, 0) / posValues.length : null;
  return {
    shows,
    clicks,
    ctr: shows > 0 ? clicks / shows : 0,
    position: position !== null ? Math.round(position * 10) / 10 : null,
    demand,
  };
}

/** Строка query-analytics → плоская строка с агрегатами. */
export function toQueryRow(it: QaTextStat): QueryRow {
  return { query: it.text_indicator?.value ?? '', ...aggregate(it.statistics ?? []) };
}

export type OrderBy = 'IMPRESSIONS' | 'CLICKS' | 'CTR' | 'POSITION' | 'DEMAND';

const ORDER_KEY: Record<OrderBy, 'shows' | 'clicks' | 'ctr' | 'position' | 'demand'> = {
  IMPRESSIONS: 'shows',
  CLICKS: 'clicks',
  CTR: 'ctr',
  POSITION: 'position',
  DEMAND: 'demand',
};

/** Сортировка топа: по убыванию (POSITION — по возрастанию); null-значения всегда в конец. */
export function sortQueries(rows: QueryRow[], orderBy: OrderBy): QueryRow[] {
  const key = ORDER_KEY[orderBy];
  return [...rows].sort((a, b) => {
    const av = a[key] ?? Number.POSITIVE_INFINITY;
    const bv = b[key] ?? Number.POSITIVE_INFINITY;
    return orderBy === 'POSITION' ? av - bv : bv - av;
  });
}

export interface RecommendedRow extends QueryRow {
  reason: 'показы без кликов' | 'позиция за топ-10' | 'есть спрос';
}

/**
 * Аппроксимация «рекомендованных запросов» (в API v4 такого эндпоинта нет) —
 * три категории: показы без кликов, позиция за топ-10, любой запрос со спросом (DEMAND > 0).
 * Сортировка: спрос, затем показы.
 */
export function filterRecommended(rows: QueryRow[], limit: number): RecommendedRow[] {
  return rows
    .filter((r) => (r.shows > 0 && r.clicks === 0) || (r.position !== null && r.position > 10) || r.demand > 0)
    .map((r) => ({
      ...r,
      reason:
        r.clicks === 0 && r.shows > 0
          ? ('показы без кликов' as const)
          : r.position !== null && r.position > 10
            ? ('позиция за топ-10' as const)
            : ('есть спрос' as const),
    }))
    .sort((a, b) => b.demand - a.demand || b.shows - a.shows)
    .slice(0, limit);
}

/** Яндекс отдаёт статистику в московской таймзоне — «сегодня» считаем по МСК (UTC+3), а не по UTC. */
const MSK_OFFSET_MS = 3 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const isoMsk = (ms: number): string => new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 10);

/** Сегодня по МСК, YYYY-MM-DD. */
export function todayMsk(now: number = Date.now()): string {
  return isoMsk(now);
}

/** Валидация порядка дат (формат YYYY-MM-DD проверяет zod-regex; здесь — только порядок). */
export function validateDateOrder(from: string, to: string): void {
  if (from > to) throw new Error(`dateFrom (${from}) позже dateTo (${to}) — поменяй даты местами`);
}

/**
 * Безусловная валидация порядка для ИНСТРУМЕНТОВ с необязательными датами:
 * одиночный dateFrom сравнивается с «сегодня» по МСК (будущий dateFrom — понятная ошибка),
 * одиночный dateTo пропускается (его проверять не с чем — дефолтное окно API ему подчинится).
 */
export function validateOptionalDateOrder(from?: string, to?: string, now: number = Date.now()): void {
  if (from && to) validateDateOrder(from, to);
  else if (from) validateDateOrder(from, todayMsk(now));
}

/** Диапазон дат YYYY-MM-DD: заданный или последние `days` дней (по МСК), с проверкой from ≤ to. */
export function dateRange(
  from: string | undefined,
  to: string | undefined,
  days: number,
  now: number = Date.now(),
): { date_from: string; date_to: string } {
  const range = { date_from: from ?? isoMsk(now - days * DAY_MS), date_to: to ?? isoMsk(now) };
  validateDateOrder(range.date_from, range.date_to);
  return range;
}

export interface PopularRow {
  query: string;
  shows: number;
  clicks: number;
  avg_show_position: number | null;
  avg_click_position: number | null;
}

const POPULAR_INDICATORS = ['TOTAL_SHOWS', 'TOTAL_CLICKS', 'AVG_SHOW_POSITION', 'AVG_CLICK_POSITION'] as const;

/**
 * Топ-запросы хоста (search-queries/popular) с пагинацией (limit API — 500 за страницу).
 * truncated: набрали ровно limit — за ним могли остаться строки; обрыв по короткой
 * странице (API отдало меньше запрошенного = данных больше нет) — НЕ truncated.
 */
export async function fetchPopular(
  hostId: string,
  opts: {
    orderBy: 'TOTAL_SHOWS' | 'TOTAL_CLICKS';
    device: string;
    limit: number;
    dateFrom?: string;
    dateTo?: string;
  },
  account?: string,
): Promise<{ rows: PopularRow[]; truncated: boolean }> {
  const userId = await getUserId(account);
  const rows: PopularRow[] = [];
  let offset = 0;
  let exhausted = false; // API отдало короткую страницу — данных больше нет

  while (rows.length < opts.limit) {
    const limit = Math.min(500, opts.limit - rows.length);
    const qs = new URLSearchParams({
      order_by: opts.orderBy,
      device_type_indicator: opts.device,
      offset: String(offset),
      limit: String(limit),
    });
    for (const ind of POPULAR_INDICATORS) qs.append('query_indicator', ind);
    if (opts.dateFrom) qs.set('date_from', opts.dateFrom);
    if (opts.dateTo) qs.set('date_to', opts.dateTo);

    const page = await ywmGet<{ queries: Array<{ query_text: string; indicators: Record<string, number> }> }>(
      `/user/${userId}/hosts/${encodeURIComponent(hostId)}/search-queries/popular?${qs}`,
      account,
    );
    const batch = page.queries ?? [];
    for (const q of batch) {
      rows.push({
        query: q.query_text,
        shows: q.indicators?.TOTAL_SHOWS ?? 0,
        clicks: q.indicators?.TOTAL_CLICKS ?? 0,
        avg_show_position: q.indicators?.AVG_SHOW_POSITION ?? null,
        avg_click_position: q.indicators?.AVG_CLICK_POSITION ?? null,
      });
    }
    if (batch.length < limit) {
      exhausted = true;
      break;
    }
    offset += batch.length;
  }
  return { rows, truncated: !exhausted && rows.length >= opts.limit };
}
