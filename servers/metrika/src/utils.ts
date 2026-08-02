/**
 * Чистая логика metrika-сервера (Яндекс.Метрика Stat API): HTTP-слой с классификацией
 * ошибок (403/404 → подсказки), дефолтные даты по МСК, валидация дат/accuracy,
 * кэш целей счётчика с дедупликацией in-flight запроса, маппинг totals landing_behavior.
 * Вынесено из index.ts для юнит-тестов (index.ts поднимает сервер — в тестах его не импортировать).
 */
import { getConfig, HttpError, yandexFetchJson } from '@seo-tools/shared';
import { assertStatRows, collectAllPages, type StatResponse } from './paginate.js';

export { assertStatRows };

export const STAT_URL = 'https://api-metrika.yandex.net/stat/v1/data';
export const MGMT_URL = 'https://api-metrika.yandex.net/management/v1';
const TOKEN_ENV = 'METRIKA_OAUTH_TOKEN';

// Базовые метрики визитов для курируемых отчётов — единый источник
// (landing_behavior и traffic_sources/geo/devices используют один и тот же набор).
export const SESSION_METRICS = ['ym:s:visits', 'ym:s:users', 'ym:s:bounceRate', 'ym:s:pageDepth', 'ym:s:avgVisitDurationSeconds'];

/** Метрика отдаёт bounceRate в процентах (0–100) — везде отдаём как есть, долей не нормализуем. */
export const BOUNCE_RATE_UNIT = 'процент (0–100)';

const MSK_OFFSET_MS = 3 * 60 * 60_000;

/** YYYY-MM-DD по Москве (UTC+3) — в этой TZ Метрика считает статистику и «сегодня». */
const mskDate = (ms: number): string => new Date(ms + MSK_OFFSET_MS).toISOString().slice(0, 10);

/** Диапазон дат YYYY-MM-DD: заданный или последние `days` дней, «сегодня» — по МСК (не UTC). */
export function metrikaDates(
  date1: string | undefined,
  date2: string | undefined,
  days: number,
  now: number = Date.now(),
): { date1: string; date2: string } {
  return { date1: date1 ?? mskDate(now - days * 864e5), date2: date2 ?? mskDate(now) };
}

/** date1 позже date2 → понятная ошибка до запроса (YYYY-MM-DD сравнивается лексикографически). */
export function validateDateRange(date1: string, date2: string, label1 = 'date1', label2 = 'date2'): void {
  if (date1 > date2) throw new Error(`${label1} (${date1}) позже ${label2} (${date2}) — начало периода должно быть раньше конца`);
}

const ACCURACY_LEVELS = ['low', 'medium', 'high', 'full'];

/**
 * Валидация accuracy по доке Метрики: low|medium|high|full или доля выборки (0,1].
 * Возвращает текст ошибки или null (для zod superRefine и юнит-тестов).
 */
export function accuracyError(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (ACCURACY_LEVELS.includes(v)) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0 && n <= 1) return null;
  return `accuracy «${value}» недопустим: low | medium | high | full или доля выборки (0,1], напр. 0.1`;
}

/** Номер счётчика: явный override или METRIKA_COUNTER_ID из конфига (лениво, с учётом account). */
export function resolveCounterId(override: number | undefined, account?: string): string {
  if (override !== undefined) return String(override);
  const id = getConfig('METRIKA_COUNTER_ID', account);
  if (!id) {
    throw new Error(
      `Не указан счётчик Метрики${account ? ` для аккаунта «${account}»` : ''}: передай counterId или сохрани дефолт ` +
        `через metrika_set_credentials${account ? ` (account="${account}")` : ''}. Список счётчиков — metrika_counters.`,
    );
  }
  return id;
}

/** 403/404 Stat/Management API → адресные подсказки про доступ и счётчик. */
function classifyMetrikaError(err: unknown): never {
  if (err instanceof HttpError) {
    if (err.status === 403) {
      throw new Error(
        `${err.message} — нет доступа к счётчику у текущего токена: список доступных — metrika_counters, ` +
          'проверь METRIKA_COUNTER_ID (metrika_set_credentials)',
      );
    }
    if (err.status === 404) {
      throw new Error(
        `${err.message} — счётчик не найден: список доступных — metrika_counters, ` +
          'задай существующий через METRIKA_COUNTER_ID (metrika_set_credentials)',
      );
    }
  }
  throw err;
}

/** GET Stat API /data (одна страница) с классификацией 403/404 и проверкой формы ответа. */
export async function statQuery(params: Record<string, string | number | undefined>, account?: string): Promise<StatResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  try {
    const res = await yandexFetchJson<StatResponse>(TOKEN_ENV, `${STAT_URL}?${qs}`, {}, account, 'metrika');
    assertStatRows(res, 'stat/v1/data');
    return res;
  } catch (err) {
    classifyMetrikaError(err);
  }
}

/** Тонкая обёртка: постраничный сбор (логика — в collectAllPages, тестируется отдельно). */
export function statQueryAll(
  params: Record<string, string | number | undefined>,
  maxRows: number,
  account?: string,
): Promise<StatResponse> {
  return collectAllPages((offset, limit) => statQuery({ ...params, limit, offset }, account), maxRows);
}

export interface BytimeResponse {
  data: Array<{ dimensions: Array<{ name: string }>; metrics: number[][] }>;
  time_intervals?: string[][];
  total_rows?: number;
  sampled?: boolean;
  sample_share?: number;
}

/** GET Stat API /bytime (динамика метрик по времени) с классификацией 403/404. */
export async function statBytime(params: Record<string, string | number | undefined>, account?: string): Promise<BytimeResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  try {
    const res = await yandexFetchJson<BytimeResponse>(TOKEN_ENV, `${STAT_URL}/bytime?${qs}`, {}, account, 'metrika');
    assertStatRows(res as unknown, 'stat/v1/data/bytime');
    return res;
  } catch (err) {
    classifyMetrikaError(err);
  }
}

/** GET Management API (списки счётчиков/целей) с классификацией 403/404. */
export async function mgmtGet<T = any>(path: string, account?: string): Promise<T> {
  try {
    return await yandexFetchJson<T>(TOKEN_ENV, `${MGMT_URL}${path}`, {}, account, 'metrika');
  } catch (err) {
    classifyMetrikaError(err);
  }
}

export interface Goal {
  id: number;
  name: string;
}

/** Цели счётчика (Management API); goals отсутствует → пустой список. */
export async function fetchGoals(counterId: string, account?: string): Promise<Goal[]> {
  const resp = await mgmtGet<{ goals?: Goal[] }>(`/counter/${counterId}/goals`, account);
  return resp.goals ?? [];
}

/**
 * Кэш целей счётчика с дедупликацией in-flight запроса (образец — createRegionNamesCache
 * в servers/wordstat/src/wordstat.ts): ключ — account + counterId, кэшируется промис,
 * а не только результат; ошибка кэш не отравляет (следующий вызов пробует снова).
 */
export function createGoalsCache(
  fetcher: (counterId: string, account?: string) => Promise<Goal[]> = fetchGoals,
  ttlMs = 10 * 60_000,
): (counterId: string, account?: string) => Promise<Goal[]> {
  const cached = new Map<string, { goals: Goal[]; ts: number }>();
  const inflight = new Map<string, Promise<Goal[]>>();
  return (counterId, account) => {
    const key = `${account ?? ''}#${counterId}`;
    const c = cached.get(key);
    if (c && Date.now() - c.ts < ttlMs) return Promise.resolve(c.goals);
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = fetcher(counterId, account)
      .then((goals) => {
        cached.set(key, { goals, ts: Date.now() });
        return goals;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, p);
    return p;
  };
}

export const GOALS_MAX = 10; // ограничение на число метрик в одном запросе Stat API

/** Обрезка целей до лимита метрик запроса — с маркерами вместо молчаливого slice. */
export function clipGoalIds(goalIds: number[], max = GOALS_MAX): { goalIds: number[]; truncated: boolean; dropped: number } {
  return { goalIds: goalIds.slice(0, max), truncated: goalIds.length > max, dropped: Math.max(0, goalIds.length - max) };
}

export interface LandingTotals {
  visits: number;
  users: number;
  /** Процент отказов 0–100 (как отдаёт Метрика). */
  bounceRate: number;
  pageDepth: number;
  avgVisitDurationSeconds: number;
  goalReaches: Record<string, number>;
}

/**
 * Маппинг totals landing_behavior: первые SESSION_METRICS.length значений — базовые метрики,
 * дальше — goal<ID>reaches в порядке goalIds. Имена целей подставляются из goalNames.
 */
export function mapLandingTotals(totals: number[], goalIds: number[], goalNames: Map<number, string>): LandingTotals {
  const base = SESSION_METRICS.length;
  const goalReaches: Record<string, number> = {};
  goalIds.forEach((g, i) => {
    const name = goalNames.get(g);
    goalReaches[name ? `${name} (#${g})` : `goal_${g}`] = totals[base + i] ?? 0;
  });
  return {
    visits: totals[0] ?? 0,
    users: totals[1] ?? 0,
    bounceRate: totals[2] ?? 0,
    pageDepth: totals[3] ?? 0,
    avgVisitDurationSeconds: totals[4] ?? 0,
    goalReaches,
  };
}

/** Флаг «ответ обрезан limit'ом»: API знает total_rows, строк вернулось меньше. */
export function isTruncated(totalRows: number | undefined, rowCount: number): boolean {
  return totalRows !== undefined && totalRows > rowCount;
}

/** sample_share прокидываем только при фактическом сэмплировании. */
export function sampleShareField(res: { sampled?: boolean; sample_share?: number }): { sample_share?: number | null } {
  return res.sampled ? { sample_share: res.sample_share ?? null } : {};
}
