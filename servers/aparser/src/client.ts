/**
 * Клиент A-Parser API + сборка опций запуска (вынесено из index.ts ради юнит-тестов —
 * tests/aparser-client.test.ts, сеть мокается). Чистые парсеры ответов — в parse.ts.
 *
 * aparserCall: POST {action,password,data}; success!==1 → осмысленная ошибка
 * (auth-ошибки классифицируются по тексту и указывают на aparser_set_credentials).
 * Сетевые ошибки/таймауты дополняются подсказкой про aparser_ping.
 */
import { fetchText, getConfig, maskSecret, maskSecretsInText, requireEnv } from '@seo-tools/shared';
import { type ProxiesView, parseProxies } from './parse.js';

/** Ключ выбора прокси-чекера (пачки) в override-опциях; сверено с пресетом (дефолт "*"). */
export const PROXY_CHECKER_OVERRIDE_ID = 'proxyChecker';

/** Тюнинг HTTP-вызова aparserCall (для тяжёлого bulkRequest — attempts:1, без ретраев). */
export interface AparserCallOptions {
  /** таймаут всего запроса (заголовки + тело), мс; дефолт 120 с */
  timeoutMs?: number;
  /** попыток всего (1 = без ретраев); дефолт — ретраи fetchText (3) */
  attempts?: number;
}

/** POST к A-Parser API; успех → json.data, иначе — осмысленная ошибка. */
export async function aparserCall(
  action: string,
  data: Record<string, unknown>,
  account?: string,
  opts: AparserCallOptions = {},
): Promise<any> {
  const base = requireEnv('APARSER_URL', account);
  const password = requireEnv('APARSER_PASSWORD', account);
  const payload: Record<string, unknown> = { action, password };
  if (data && Object.keys(data).length) payload.data = data;

  let text: string;
  try {
    text = await fetchText(base, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      body: JSON.stringify(payload),
      timeoutMs: opts.timeoutMs ?? 120_000,
      attempts: opts.attempts,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${msg} — инстанс A-Parser недоступен? Проверьте связь (aparser_ping) и APARSER_URL/APARSER_PASSWORD (aparser_set_credentials).`,
    );
  }

  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    // тело может эхом содержать «ключ=значение» — маскируем секреты перед показом
    const snippet = maskSecretsInText(text.slice(0, 120));
    throw new Error(
      `A-Parser вернул не JSON (${snippet}). Проверьте APARSER_URL — он должен указывать на эндпоинт …/API, а API-сервер быть включён (Settings → API). aparser_auth_status.`,
    );
  }
  if (json?.success !== 1) {
    const msg = String(json?.msg || json?.message || json?.data?.msg || 'неизвестная ошибка');
    if (/pass|denied|access|auth|доступ|парол/i.test(msg)) {
      throw new Error(`A-Parser: доступ отклонён (${msg}). Проверьте APARSER_PASSWORD (aparser_set_credentials).`);
    }
    throw new Error(`A-Parser error: ${msg}`);
  }
  return json.data;
}

/** Дефолтные прокси-пачки из env (APARSER_PROXY_CHECKERS="a,b"). */
export function defaultCheckers(account?: string): string[] | undefined {
  const v = getConfig('APARSER_PROXY_CHECKERS', account);
  if (!v) return undefined;
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

/** Дефолт use_proxy (APARSER_USE_PROXY), по умолчанию true. */
export function defaultUseProxy(account?: string): boolean {
  const v = getConfig('APARSER_USE_PROXY', account);
  if (v == null || v === '') return true;
  return /^(1|true|yes|on)$/i.test(v);
}

/** Живые прокси инстанса (опц. только указанных пачек). */
export async function getLiveProxies(checkers: string[] | undefined, account?: string): Promise<ProxiesView> {
  const data = await aparserCall('getProxies', checkers?.length ? { checkers } : {}, account);
  return parseProxies(data);
}

/**
 * Сборка override-опций A-Parser (формат элемента — {type:'override',id,value}).
 * Пропускает undefined. useproxy и выбор прокси-чекера включены сюда.
 */
export function buildOverrides(
  map: Record<string, string | number | boolean | undefined>,
): Array<{ type: 'override'; id: string; value: string }> {
  const out: Array<{ type: 'override'; id: string; value: string }> = [];
  for (const [id, value] of Object.entries(map)) {
    if (value === undefined || value === '') continue;
    out.push({ type: 'override', id, value: typeof value === 'boolean' ? (value ? '1' : '0') : String(value) });
  }
  return out;
}

/** Preflight: при use_proxy проверяем, что в выбранных пачках есть живые прокси. */
export async function ensureProxies(useProxy: boolean, checkers: string[] | undefined, account?: string): Promise<void> {
  if (!useProxy) return;
  const { count } = await getLiveProxies(checkers, account);
  if (count === 0) {
    const where = checkers?.length ? `в пачках [${checkers.join(', ')}]` : 'ни в одной пачке';
    throw new Error(
      `A-Parser: живых прокси ${where} нет — SERP по Google/Яндексу почти наверняка забанится. ` +
        `Загрузите прокси и запустите Proxy Checker в GUI, либо укажите use_proxy=false на свой риск. aparser_proxies — текущее состояние.`,
    );
  }
}

/** Разрешить пресет/пачки/use_proxy из аргументов с фолбэком на env-дефолты. */
export function resolveExec(args: any, presetEnv: string): { preset: string; checkers: string[] | undefined; useProxy: boolean } {
  const preset = args.preset || getConfig(presetEnv, args.account) || 'default';
  const checkers = args.checkers?.length ? args.checkers : defaultCheckers(args.account);
  const useProxy = args.use_proxy ?? defaultUseProxy(args.account);
  return { preset, checkers, useProxy };
}

/** Имена опций пресета, значения которых маскируем (креды прокси, API-ключи парсеров). */
const SENSITIVE_OPTION_RE = /pass|key|token|secret/i;

/** Опции пресета с замаскированными значениями чувствительных ключей (pass|key|token|secret). */
export function maskPresetOptions(options: any): any {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    out[k] = v != null && v !== '' && SENSITIVE_OPTION_RE.test(k) ? maskSecret(typeof v === 'string' ? v : JSON.stringify(v)) : v;
  }
  return out;
}
