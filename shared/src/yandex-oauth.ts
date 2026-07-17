/**
 * OAuth Яндекса (общий для Вебмастера и Метрики — одно приложение с обоими scope):
 *  - code flow c refresh-токеном (авторизация «на годы», токен обновляется сам);
 *  - registerYandexOauthTools() добавляет серверу <prefix>_oauth_start / <prefix>_oauth_finish;
 *  - yandexFetchJson() ходит в API и при 401 прозрачно рефрешит токен.
 *
 * Env: YANDEX_CLIENT_ID, YANDEX_CLIENT_SECRET (общие для всех аккаунтов — одно приложение),
 * YANDEX_OAUTH_TOKEN, YANDEX_REFRESH_TOKEN (+ __<account> для мультиаккаунта).
 * Специфичные YWM_OAUTH_TOKEN / METRIKA_OAUTH_TOKEN (если заданы) имеют приоритет —
 * для случая раздельных приложений; авто-refresh на них НЕ распространяется
 * (общий refresh-токен принадлежит другому приложению/scope — подменять нельзя).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchJson, HttpError, type FetchRetryOptions } from './http.js';
import { jsonResult, safeHandler } from './mcp.js';
import { saveEnvValues, maskSecret, envKey, accountsFor, getConfig, readConfigFile } from './config.js';
import { envOr } from './env.js';

const TOKEN_URL = 'https://oauth.yandex.ru/token';

function readTokens(specificEnv: string, account?: string): { specific?: string; general?: string } {
  return {
    specific: getConfig(specificEnv, account),
    general: getConfig('YANDEX_OAUTH_TOKEN', account),
  };
}

export function getYandexToken(specificEnv: string, account?: string): string {
  let { specific, general } = readTokens(specificEnv, account);
  if (!specific && !general) {
    readConfigFile(true); // страховка от записи в ту же миллисекунду
    ({ specific, general } = readTokens(specificEnv, account));
  }
  const token = specific || general;
  if (!token) {
    const known = accountsFor('YANDEX_OAUTH_TOKEN');
    throw new Error(
      `Нет OAuth-токена Яндекса${account ? ` для аккаунта «${account}»` : ''} ` +
      `(${envKey(specificEnv, account)} или ${envKey('YANDEX_OAUTH_TOKEN', account)}). ` +
      (known.length ? `Настроенные аккаунты: ${known.join(', ')}. ` : '') +
      `Запусти <server>_oauth_start${account ? ` c account="${account}"` : ''} или сохрани готовый токен через <server>_set_credentials.`,
    );
  }
  return token;
}

async function exchangeToken(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  return fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

// OAuth-коды отказа, при которых refresh-токен/грант заведомо не сработает (RFC 6749 §5.2).
// Переавторизация (oauth_start заново собирает clientId/secret и грант) исправляет все три.
const DEAD_GRANT_CODES = /"error"\s*:\s*"(invalid_grant|invalid_client|unauthorized_client)"/i;

/**
 * Классифицирует ошибку обмена refresh-токена:
 *  true  — грант мёртв: тело несёт OAuth-код отказа (invalid_grant/…) — нужна переавторизация;
 *  false — транзиент: 5xx / timeout / сеть / 408 / 429, а также ЛЮБОЙ 4xx без OAuth-кода
 *          в теле (например 400/403 от прокси перед oauth.yandex.ru) — токен ещё жив,
 *          гнать пользователя на бесполезную переавторизацию нельзя.
 * HttpError уже несёт .status и .bodySnippet, отдельный класс не нужен.
 */
export function isDeadGrant(err: unknown): boolean {
  if (err instanceof HttpError) {
    if (err.status === 408 || err.status === 429) return false; // rate-limit / request-timeout — транзиент
    if (err.status >= 400 && err.status < 500) return DEAD_GRANT_CODES.test(err.bodySnippet); // 4xx: «мёртв» только по OAuth-коду
    return false; // 5xx — транзиент
  }
  return false; // AbortError (timeout) / TypeError (сеть) — транзиент
}

/**
 * Обновляет ОБЩИЙ токен по refresh-токену.
 * Возвращает null — если обновлять нечем ИЛИ грант мёртв (→ переавторизация).
 * Бросает — при транзиентной ошибке (5xx/timeout): refresh-токен жив, повтор позже.
 */
async function tryRefresh(account?: string): Promise<string | null> {
  const refreshToken = getConfig('YANDEX_REFRESH_TOKEN', account);
  // OAuth-приложение общее для всех аккаунтов → client id/secret с мягким фолбэком на основной
  const clientId = envOr('YANDEX_CLIENT_ID', account);
  const clientSecret = envOr('YANDEX_CLIENT_SECRET', account);
  if (!refreshToken || !clientId || !clientSecret) return null;
  try {
    const data = await exchangeToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    });
    const values: Record<string, string> = { [envKey('YANDEX_OAUTH_TOKEN', account)]: data.access_token };
    // refresh пишем только при фактической ротации — лишняя запись конфига дёргает файл зря
    if (data.refresh_token && data.refresh_token !== refreshToken) values[envKey('YANDEX_REFRESH_TOKEN', account)] = data.refresh_token;
    if (data.expires_in) values[envKey('YANDEX_TOKEN_EXPIRES', account)] = new Date(Date.now() + data.expires_in * 1000).toISOString();
    saveEnvValues(values);
    console.error(`[yandex-oauth] токен${account ? ` аккаунта «${account}»` : ''} обновлён по refresh-токену`);
    return data.access_token;
  } catch (err) {
    if (isDeadGrant(err)) {
      console.error(`[yandex-oauth] refresh отклонён (грант мёртв, нужна переавторизация): ${String(err)}`);
      return null;
    }
    // Транзиент (5xx/timeout/сеть/408/429): refresh-токен НЕ протух — не гоним на переавторизацию,
    // пробрасываем понятную временную ошибку, чтобы вызов можно было повторить позже.
    console.error(`[yandex-oauth] refresh временно не удался (транзиент): ${String(err)}`);
    throw new Error(
      `Не удалось обновить OAuth-токен Яндекса${account ? ` аккаунта «${account}»` : ''} из-за временной ошибки ` +
      `(${String(err)}). Refresh-токен НЕ протух — повтори запрос позже.`,
    );
  }
}

/** fetchJson к API Яндекса с OAuth-заголовком и авто-рефрешем при 401. */
export async function yandexFetchJson<T = any>(
  specificTokenEnv: string,
  url: string,
  opts: FetchRetryOptions = {},
  account?: string,
): Promise<T> {
  const exec = (token: string) =>
    fetchJson<T>(url, { ...opts, headers: { ...(opts.headers ?? {}), Authorization: `OAuth ${token}` } });

  const { specific, general } = readTokens(specificTokenEnv, account);
  try {
    return await exec(getYandexToken(specificTokenEnv, account));
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 401)) throw err;

    // 401: рефрешим только если использовался ОБЩИЙ токен — специфичный может быть
    // от другого приложения/scope, подменять его токеном общего приложения нельзя
    const usedSpecificForeign = Boolean(specific) && specific !== general;
    if (usedSpecificForeign) {
      throw new Error(
        `Токен ${envKey(specificTokenEnv, account)} протух. Авто-refresh для отдельного токена не выполняется ` +
        '(общий YANDEX_REFRESH_TOKEN может принадлежать другому приложению) — обнови его через <server>_set_credentials ' +
        'или перейди на общий токен: <server>_oauth_start → <server>_oauth_finish.',
      );
    }
    const fresh = await tryRefresh(account);
    if (fresh) {
      try {
        return await exec(fresh);
      } catch (err2) {
        // Свежий токен снова 401 → доступ приложения, вероятно, отозван; не крутим бесконечно
        if (err2 instanceof HttpError && err2.status === 401) {
          throw new Error(
            `OAuth-токен Яндекса${account ? ` аккаунта «${account}»` : ''} отклонён (401) даже после обновления по refresh — ` +
            'вероятно, доступ приложения отозван. Переавторизуйся: <server>_oauth_start → <server>_oauth_finish.',
          );
        }
        throw err2;
      }
    }
    throw new Error(
      `OAuth-токен Яндекса${account ? ` аккаунта «${account}»` : ''} протух, а refresh-токена/клиента для обновления нет. ` +
      'Переавторизуйся: <server>_oauth_start → <server>_oauth_finish.',
    );
  }
}

/** Регистрирует у сервера пару инструментов интерактивной авторизации Яндекса. */
export function registerYandexOauthTools(server: McpServer, prefix: string, scopesHint: string, onSave?: () => void): void {
  server.registerTool(
    `${prefix}_oauth_start`,
    {
      description:
        'Шаг 1 авторизации Яндекса: вернёт ссылку, которую пользователь открывает в браузере, ' +
        'разрешает доступ и получает код подтверждения. Код передать в ' + `${prefix}_oauth_finish. ` +
        `Требуется OAuth-приложение (oauth.yandex.ru/client/new, Redirect URI: https://oauth.yandex.ru/verification_code, scope: ${scopesHint}). ` +
        'clientId/clientSecret сохраняются для дальнейшего авто-обновления токена (приложение ОБЩЕЕ для всех аккаунтов). ' +
        'account — имя профиля для мультиаккаунта: пользователь авторизуется под ДРУГИМ Яндекс-аккаунтом, токен сохранится отдельно.',
      inputSchema: {
        clientId: z.string().optional().describe('ClientID приложения (если не сохранён ранее как YANDEX_CLIENT_ID)'),
        clientSecret: z.string().optional().describe('Client secret приложения (для обмена кода и refresh)'),
        account: z.string().optional().describe('Имя аккаунта-профиля (мультиаккаунт); пусто = основной'),
      },
    },
    safeHandler(async (args) => {
      const values: Record<string, string> = {};
      if (args.clientId) values.YANDEX_CLIENT_ID = args.clientId.trim();
      if (args.clientSecret) values.YANDEX_CLIENT_SECRET = args.clientSecret.trim();
      if (Object.keys(values).length) saveEnvValues(values);
      const clientId = envOr('YANDEX_CLIENT_ID', args.account);
      if (!clientId) {
        return jsonResult({
          ready: false,
          action: 'Сначала зарегистрируй приложение на https://oauth.yandex.ru/client/new ' +
            `(Веб-сервисы, Redirect URI: https://oauth.yandex.ru/verification_code, scope: ${scopesHint}) ` +
            'и передай clientId (+ clientSecret) в этот инструмент.',
        });
      }
      return jsonResult({
        ready: true,
        account: args.account ?? null,
        authorizeUrl: `https://oauth.yandex.ru/authorize?response_type=code&client_id=${clientId}&force_confirm=yes`,
        next: `Пользователь открывает ссылку под ${args.account ? `Яндекс-аккаунтом профиля «${args.account}»` : 'аккаунтом-владельцем сайта/счётчика'}, ` +
          `разрешает доступ, копирует код подтверждения со страницы и передаёт его в ${prefix}_oauth_finish` +
          `${args.account ? ` вместе с account="${args.account}"` : ''}.`,
        hasClientSecret: Boolean(envOr('YANDEX_CLIENT_SECRET', args.account)),
      });
    }),
  );

  server.registerTool(
    `${prefix}_oauth_finish`,
    {
      description:
        'Шаг 2 авторизации Яндекса: обменивает код подтверждения на access+refresh токены и сохраняет их ' +
        '(с суффиксом профиля, если передан account). После этого токен обновляется автоматически при протухании.',
      inputSchema: {
        code: z.string().describe('Код подтверждения со страницы Яндекса'),
        account: z.string().optional().describe('Имя аккаунта-профиля — то же, что в oauth_start'),
      },
    },
    safeHandler(async (args) => {
      const clientId = envOr('YANDEX_CLIENT_ID', args.account);
      const clientSecret = envOr('YANDEX_CLIENT_SECRET', args.account);
      if (!clientId || !clientSecret) {
        throw new Error('Нужны YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET — передай их в ' + `${prefix}_oauth_start.`);
      }
      const data = await exchangeToken({
        grant_type: 'authorization_code',
        code: args.code.trim(),
        client_id: clientId,
        client_secret: clientSecret,
      });
      const values: Record<string, string> = { [envKey('YANDEX_OAUTH_TOKEN', args.account)]: data.access_token };
      if (data.refresh_token) values[envKey('YANDEX_REFRESH_TOKEN', args.account)] = data.refresh_token;
      if (data.expires_in) values[envKey('YANDEX_TOKEN_EXPIRES', args.account)] = new Date(Date.now() + data.expires_in * 1000).toISOString();
      saveEnvValues(values);
      onSave?.();
      return jsonResult({
        ok: true,
        account: args.account ?? null,
        token: maskSecret(data.access_token),
        refreshToken: Boolean(data.refresh_token),
        expiresAt: values[envKey('YANDEX_TOKEN_EXPIRES', args.account)] ?? null,
      });
    }),
  );
}
