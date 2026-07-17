/**
 * HTTP-клиент с ретраями и таймаутом для всех MCP-серверов.
 * Ретраит 429 и 5xx с экспоненциальным backoff (по умолчанию 3 попытки).
 * Таймаут покрывает ВЕСЬ запрос, включая чтение тела (AbortSignal жив до конца
 * res.text()) — зависший/капающий стрим тела обрывается, а не висит вечно.
 */

import { maskUrl } from './config.js';

export interface FetchRetryOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** таймаут одного запроса (заголовки + тело), мс */
  timeoutMs?: number;
  /** число попыток всего (1 = без ретраев) */
  attempts?: number;
  /** базовая задержка перед ретраем, мс (удваивается каждый раз + jitter) */
  backoffMs?: number;
  /** какие HTTP-статусы ретраить (по умолчанию 429 и 5xx) */
  retryOn?: (status: number) => boolean;
}

export class HttpError extends Error {
  /** URL с замаскированными секретами — безопасен для логов (в т.ч. в .message). */
  public url: string;
  /** Исходный URL без маскирования — для программного использования (retry/дедуп/корреляция). НЕ логировать. */
  public rawUrl: string;
  constructor(
    public status: number,
    url: string,
    public bodySnippet: string,
  ) {
    const safe = maskUrl(url);
    super(`HTTP ${status} for ${safe}: ${bodySnippet.slice(0, 300)}`);
    this.name = 'HttpError';
    this.url = safe;
    this.rawUrl = url;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AttemptResult {
  status: number;
  ok: boolean;
  text: string;
  retryAfterMs: number | null;
}

async function attemptOnce(
  url: string,
  init: Omit<FetchRetryOptions, 'timeoutMs' | 'attempts' | 'backoffMs'>,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text(); // тело читается ПОД тем же таймером
    const retryAfter = Number(res.headers.get('retry-after'));
    return {
      status: res.status,
      ok: res.ok,
      text,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Экспоненциальный backoff с полным jitter — рассинхронизирует всплеск параллельных ретраев. */
function backoffWithJitter(base: number, attempt: number): number {
  const exp = base * 2 ** (attempt - 1);
  return Math.round(exp * (0.5 + Math.random() * 0.5));
}

/** GET/POST с ретраями; возвращает тело ответа строкой. */
export async function fetchText(url: string, opts: FetchRetryOptions = {}): Promise<string> {
  const { attempts = 3, backoffMs = 1000, timeoutMs = 60_000, retryOn, ...init } = opts;
  const isRetriable = retryOn ?? ((status: number) => status === 429 || status >= 500);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res: AttemptResult;
    try {
      res = await attemptOnce(url, init, timeoutMs);
    } catch (err) {
      // сюда попадают только сетевые сбои и таймауты — HTTP-статусы обрабатываются ниже
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const isNetwork = err instanceof TypeError; // fetch network failure
      if (!(isAbort || isNetwork) || attempt === attempts) throw err;
      const delay = backoffWithJitter(backoffMs, attempt);
      console.error(`[http] ${isAbort ? 'timeout' : 'network error'} ${maskUrl(url)} — retry ${attempt}/${attempts - 1} in ${delay}ms`);
      await sleep(delay);
      continue;
    }

    if (res.ok) return res.text;
    if (!isRetriable(res.status) || attempt === attempts) throw new HttpError(res.status, url, res.text);

    // Retry-After (если сервер прислал) уважаем точно; иначе — jitter-backoff
    const delay = res.retryAfterMs ?? backoffWithJitter(backoffMs, attempt);
    console.error(`[http] ${res.status} ${maskUrl(url)} — retry ${attempt}/${attempts - 1} in ${delay}ms`);
    await sleep(delay);
  }
  throw new Error(`fetchText: исчерпаны попытки для ${maskUrl(url)}`); // недостижимо, для полноты типов
}

export async function fetchJson<T = unknown>(url: string, opts: FetchRetryOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Невалидный JSON от ${maskUrl(url)}: ${text.slice(0, 200)}`);
  }
}
