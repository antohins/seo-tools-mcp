/**
 * Чистая логика wordstat-сервера (официальный Wordstat API v2, Yandex Cloud):
 * HTTP-слой с классификацией ошибок, маппинг устройств, точная форма фразы,
 * валидация дат dynamics и кэш дерева регионов с дедупликацией in-flight запроса.
 * Вынесено из index.ts для юнит-тестов (index.ts поднимает сервер — в тестах его не импортировать).
 */
import { fetchJson, HttpError, requireEnv } from '@seo-tools/shared';

export const BASE = 'https://searchapi.api.cloud.yandex.net/v2/wordstat';

const DEVICE_MAP: Record<string, string> = {
  all: 'DEVICE_ALL',
  desktop: 'DEVICE_DESKTOP',
  phone: 'DEVICE_PHONE',
  tablet: 'DEVICE_TABLET',
};

/** «desktop,phone» → ['DEVICE_DESKTOP','DEVICE_PHONE']; all/пусто → undefined (не шлём). */
export function resolveDevices(device: string | undefined): string[] | undefined {
  if (!device || device === 'all') return undefined;
  return device.split(',').map((d) => {
    const v = DEVICE_MAP[d.trim().toLowerCase()];
    if (!v) throw new Error(`Неизвестное устройство «${d}» — допустимо: all, desktop, phone, tablet`);
    return v;
  });
}

/** count/totalCount приходят строками (proto int64) — приводим к number, мусор → 0. */
export const toNum = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * true, если во фразе уже есть операторы Вордстата — тогда точную форму не строим сами.
 * ВАЖНО: дефис/минус и «+» — операторы только В НАЧАЛЕ слова (« -слово», «+на»);
 * дефис внутри слова («санкт-петербург») оператором НЕ является.
 */
export const hasOperators = (q: string): boolean => /["[\]()|]/.test(q) || /(^|\s)[!+-]\S/.test(q);

/** «купить квартиру» → «"!купить !квартиру"» (точная частотность как в веб-Вордстате). */
export function exactForm(query: string): string {
  return `"${query
    .trim()
    .split(/\s+/)
    .map((w) => `!${w}`)
    .join(' ')}"`;
}

/**
 * POST к Wordstat API с классификацией ошибок:
 * 401/403 — подсказка про ключи/роль; финальный 429 (после ретраев fetchJson) — про часовую квоту.
 */
export async function wordstatPost<T = any>(path: string, body: Record<string, unknown>, account?: string): Promise<T> {
  const apiKey = requireEnv('WORDSTAT_API_KEY', account);
  const folderId = requireEnv('WORDSTAT_FOLDER_ID', account);
  try {
    return await fetchJson<T>(`${BASE}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ folderId, ...body }),
      timeoutMs: 60_000,
    });
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 401 || e.status === 403) {
        throw new Error(
          `${e.message} — проверьте WORDSTAT_API_KEY/WORDSTAT_FOLDER_ID и роль search-api.webSearch.user ` +
            'у сервисного аккаунта (wordstat_set_credentials / wordstat_auth_status)',
        );
      }
      if (e.status === 429) {
        throw new Error(
          `${e.message} — превышена квота Wordstat API (10 запросов/сек, 100 запросов/час): ` +
            'повторите позже или сократите частоту вызовов',
        );
      }
    }
    throw e;
  }
}

export type DynamicsPeriod = 'daily' | 'weekly' | 'monthly';

const DAY_MS = 24 * 60 * 60_000;
const MSK_OFFSET_MS = 3 * 60 * 60_000; // «сегодня» для daily-границы — по МСК, как в metrika/ywm (Wordstat живёт в МСК)
const parseUtc = (d: string): Date => new Date(`${d}T00:00:00Z`);

/** «Сегодня» по МСК как UTC-полночь (для сравнения с parseUtc-датами). */
const todayMskUtc = (now: Date): number => Date.parse(`${new Date(now.getTime() + MSK_OFFSET_MS).toISOString().slice(0, 10)}T00:00:00Z`);

/**
 * Валидация дат wordstat_dynamics ПЕРЕД запросом (API иначе молча возвращает пусто/ошибку).
 * Правила из доки Яндекса: monthly — fromDate 1-е число, toDate последний день месяца;
 * weekly — fromDate понедельник; daily — данные только за последние 60 дней (граница по МСК).
 * Даты сравниваем в UTC, чтобы не зависеть от TZ процесса.
 */
export function validateDynamicsDates(period: DynamicsPeriod, fromDate: string, toDate: string, now: Date = new Date()): void {
  const from = parseUtc(fromDate);
  const to = parseUtc(toDate);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new Error('fromDate/toDate должны быть валидными датами YYYY-MM-DD');
  }
  if (from.getTime() > to.getTime()) {
    throw new Error(`fromDate (${fromDate}) позже toDate (${toDate})`);
  }
  if (period === 'monthly') {
    if (from.getUTCDate() !== 1) {
      throw new Error(`monthly: fromDate должен быть 1-м числом месяца (получено ${fromDate})`);
    }
    const lastDay = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)).getUTCDate();
    if (to.getUTCDate() !== lastDay) {
      throw new Error(`monthly: toDate должен быть последним днём месяца (для ${toDate.slice(0, 7)} это ${lastDay}-е, получено ${toDate})`);
    }
  }
  if (period === 'weekly' && from.getUTCDay() !== 1) {
    throw new Error(`weekly: fromDate должен быть понедельником (получено ${fromDate})`);
  }
  if (period === 'daily') {
    if (todayMskUtc(now) - from.getTime() > 60 * DAY_MS) {
      throw new Error(`daily: данные доступны только за последние 60 дней (fromDate ${fromDate} слишком ранняя)`);
    }
  }
}

/**
 * Кэш дерева регионов с дедупликацией in-flight запроса (образец — xmlstock/src/wordstat.ts):
 * без него два параллельных вызова при холодном кэше уходят в два запроса getRegionsTree.
 * Кэшируем промис, а не только результат; по TTL кэш перечитывается.
 */
export function createRegionNamesCache(
  fetchNames: () => Promise<Map<string, string>>,
  ttlMs = 24 * 60 * 60_000,
): () => Promise<Map<string, string>> {
  let cached: { names: Map<string, string>; ts: number } | null = null;
  let inflight: Promise<Map<string, string>> | null = null;
  return async () => {
    if (cached && Date.now() - cached.ts < ttlMs) return cached.names;
    if (inflight) return inflight;
    inflight = fetchNames()
      .then((names) => {
        cached = { names, ts: Date.now() };
        return names;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
