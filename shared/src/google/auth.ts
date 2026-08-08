/**
 * Общая авторизация Google для серверов семейства (gsc, ga4): OAuth пользователя
 * с автообновлением токена + альтернативный путь через сервис-аккаунт.
 *
 * Вынесено из servers/gsc в @seo-tools/shared/google ОТДЕЛЬНЫМ subpath: тянет
 * google-auth-library, поэтому не должно попадать в бандлы не-Google серверов
 * (тот же приём, что и у ./serp с fast-xml-parser).
 *
 * Поведение сохранено ровно как в gsc: кеш access-токена по профилю, дедуп
 * параллельных refresh (один обмен на всех), ленивое создание JWT-клиента,
 * 401-ретрай только для OAuth-пути (у сервис-аккаунта JWT кеширует токен сам),
 * 403 → доменная подсказка сервера.
 */
import { JWT } from 'google-auth-library';
import { getConfig, validateAccount } from '../config.js';
import { envOr } from '../env.js';
import { fetchJson, HttpError } from '../http.js';

/** true — Google отверг refresh-токен (invalid_grant): токен отозван или истёк, нужна переавторизация. */
export function isInvalidGrant(err: unknown): boolean {
  return err instanceof HttpError && err.bodySnippet.includes('invalid_grant');
}

/**
 * Имя файла SA-ключа внутри CONFIG_DIR. account валидируется ДО склейки пути:
 * '../../tmp/x' отклоняется здесь (path traversal), а не позже в saveEnvValues.
 */
export function saJsonFileName(prefix: string, account?: string): string {
  const acc = validateAccount(account);
  return acc ? `${prefix}-sa__${acc}.json` : `${prefix}-sa.json`;
}

export interface GoogleAuthConfig {
  /** префикс инструментов сервера: 'gsc' | 'ga4' — подставляется в тексты ошибок */
  toolPrefix: string;
  /** OAuth scope (…/auth/webmasters.readonly, …/auth/analytics.readonly) */
  scope: string;
  /** env с refresh-токеном профиля (GSC_REFRESH_TOKEN) */
  refreshEnv: string;
  /** env с путём к JSON-ключу сервис-аккаунта (GSC_SA_JSON) */
  saJsonEnv: string;
  /** имя API в тексте 401 для сервис-аккаунта («Search Console API») */
  apiName: string;
  /** текст «нет авторизации вообще» (доменный: какие инструменты звать) */
  noAuthHint: (account?: string) => string;
  /** текст 403 (доменный: нет доступа к свойству/ресурсу) */
  forbiddenHint: (context?: string) => string;
}

export interface GoogleAuth {
  /** Access-токен профиля: OAuth (приоритет) или сервис-аккаунт. */
  getAccessToken(account?: string): Promise<{ token: string; via: 'oauth' | 'sa' }>;
  /** fetch к Google API с Bearer-токеном, 401-ретраем (только OAuth) и классификацией 403. */
  googleFetch<T>(
    url: string,
    init: { method?: 'GET' | 'POST'; body?: string; attempts?: number },
    account?: string,
    context?: string,
  ): Promise<T>;
  /** Сброс кешей токенов/JWT (после сохранения новых ключей). */
  resetCaches(): void;
  /** OAuth client id/secret профиля (общие для всех профилей, с фолбэком на базовые). */
  clientCreds(account?: string): { clientId: string; clientSecret: string };
  /** Текст ошибки чтения/использования JSON-ключа сервис-аккаунта. */
  saKeyErrorText(keyFile: string, err: unknown): string;
}

export function createGoogleAuth(cfg: GoogleAuthConfig): GoogleAuth {
  // кеши авторизации: ключ = имя аккаунта-профиля ('' = основной)
  const jwtClients = new Map<string, { keyFile: string; client: JWT }>();
  const cachedAccess = new Map<string, { token: string; exp: number }>();
  // in-flight refresh-промисы по аккаунтам: параллельные вызовы делят ОДИН обмен
  // refresh→access (по эталону shared/yandex-oauth.ts), не плодя запросы к Google
  const refreshInflight = new Map<string, Promise<string>>();

  const resetCaches = (): void => {
    jwtClients.clear();
    cachedAccess.clear();
  };

  /** OAuth-клиент общий для всех профилей: суффикс → основной; понятная ошибка если нет. */
  const clientCreds = (account?: string): { clientId: string; clientSecret: string } => {
    const clientId = envOr('GOOGLE_CLIENT_ID', account);
    const clientSecret = envOr('GOOGLE_CLIENT_SECRET', account);
    if (!clientId || !clientSecret) {
      throw new Error(
        `Нет GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET — создай OAuth client (Desktop app) в console.cloud.google.com и передай в ${cfg.toolPrefix}_oauth_start.`,
      );
    }
    return { clientId, clientSecret };
  };

  const saKeyErrorText = (keyFile: string, err: unknown): string =>
    `Не удалось получить токен по ключу сервис-аккаунта (${keyFile}): ${err instanceof Error ? err.message : String(err)}. ` +
    `Проверь путь ${cfg.saJsonEnv} (${cfg.toolPrefix}_auth_status); обновить ключ — ${cfg.toolPrefix}_save_sa_json / ${cfg.toolPrefix}_set_credentials.`;

  /** Обмен refresh→access у Google; кладёт результат в cachedAccess. */
  const refreshAccessToken = async (account: string | undefined, refreshToken: string, cacheKey: string): Promise<string> => {
    const { clientId, clientSecret } = clientCreds(account);
    const data = await fetchJson<{ access_token: string; expires_in?: number }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    }).catch((err) => {
      if (isInvalidGrant(err)) {
        throw new Error(
          'Google отверг refresh-токен (invalid_grant) — токен отозван или истёк (Testing-режим = 7 дней). ' +
            `Переавторизуйся: ${cfg.toolPrefix}_oauth_start → ${cfg.toolPrefix}_oauth_finish.`,
        );
      }
      throw err;
    });
    cachedAccess.set(cacheKey, { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 });
    return data.access_token;
  };

  const getAccessToken = async (account?: string): Promise<{ token: string; via: 'oauth' | 'sa' }> => {
    const cacheKey = account ?? '';
    // Путь 1: OAuth пользователя (приоритетный — видит все ресурсы аккаунта)
    const refreshToken = getConfig(cfg.refreshEnv, account);
    if (refreshToken) {
      const hit = cachedAccess.get(cacheKey);
      if (hit && Date.now() < hit.exp - 60_000) return { token: hit.token, via: 'oauth' };
      // дедуп параллельных refresh: ждём общий промис, а не делаем второй обмен
      const inflight = refreshInflight.get(cacheKey);
      if (inflight) return { token: await inflight, via: 'oauth' };
      const p = refreshAccessToken(account, refreshToken, cacheKey).finally(() => {
        if (refreshInflight.get(cacheKey) === p) refreshInflight.delete(cacheKey);
      });
      refreshInflight.set(cacheKey, p);
      return { token: await p, via: 'oauth' };
    }

    // Путь 2: сервис-аккаунт
    const keyFile = getConfig(cfg.saJsonEnv, account);
    if (!keyFile) throw new Error(cfg.noAuthHint(account));
    const cached = jwtClients.get(cacheKey);
    let client = cached?.keyFile === keyFile ? cached.client : undefined;
    if (!client) {
      try {
        client = new JWT({ keyFile, scopes: [cfg.scope] });
      } catch (err) {
        throw new Error(saKeyErrorText(keyFile, err));
      }
      jwtClients.set(cacheKey, { keyFile, client });
    }
    const { token } = await client.getAccessToken().catch((err: unknown) => {
      jwtClients.delete(cacheKey); // следующий вызов пересоздаст клиент (например, после починки файла)
      throw new Error(saKeyErrorText(keyFile, err)); // google-auth-library читает keyFile лениво — ENOENT всплывает здесь
    });
    if (!token) throw new Error(`Не удалось получить access token по сервис-аккаунту (${cfg.saJsonEnv})`);
    return { token, via: 'sa' };
  };

  /**
   * fetch к Google API с авторизацией.
   * 401: повтор со свежим токеном — только для OAuth-пути (у сервис-аккаунта JWT кеширует
   * токен сам, повтор с тем же ключом бессмысленен → сразу понятная ошибка).
   * 403: классифицируется доменной подсказкой сервера.
   */
  const googleFetch = async <T>(
    url: string,
    init: { method?: 'GET' | 'POST'; body?: string; attempts?: number },
    account?: string,
    context?: string,
  ): Promise<T> => {
    const { attempts, ...rest } = init;
    let via: 'oauth' | 'sa' | null = null; // какой путь авторизации сработал в exec (null — токен не получен)
    const exec = async () => {
      const auth = await getAccessToken(account);
      via = auth.via;
      return fetchJson<T>(url, {
        ...rest,
        headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
        timeoutMs: 120_000, // ceiling для «жирных» страниц; быстрым вызовам безвреден
        ...(attempts !== undefined ? { attempts } : {}), // ретраи ограничиваем только там, где нужно (пагинация)
      });
    };
    try {
      return await exec();
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        if (via === 'sa') {
          throw new Error(
            `Google отклонил токен сервис-аккаунта (401) — ключ отозван или ${cfg.apiName} не включён в проекте. ` +
              `Проверь: ${cfg.toolPrefix}_auth_status; обновить ключ — ${cfg.toolPrefix}_save_sa_json.`,
          );
        }
        cachedAccess.delete(account ?? ''); // токен отозван раньше expires_in — берём свежий
        return exec();
      }
      if (err instanceof HttpError && err.status === 403) {
        throw new Error(cfg.forbiddenHint(context));
      }
      throw err;
    }
  };

  return { getAccessToken, googleFetch, resetCaches, clientCreds, saKeyErrorText };
}
