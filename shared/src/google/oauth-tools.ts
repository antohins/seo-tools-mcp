/**
 * Общие OAuth-инструменты Google для серверов семейства (gsc, ga4):
 *   <prefix>_oauth_start   — ссылка авторизации + подъём loopback-приёмника кода;
 *   <prefix>_oauth_finish  — обмен кода на access+refresh, сохранение refresh;
 *   <prefix>_save_sa_json  — сохранение JSON-ключа сервис-аккаунта (права 600).
 *
 * Вынесено из servers/gsc без изменения поведения: код привязан к flow (state + профиль),
 * при account клиентские креды пишутся в профильные ключи (базовые не перетираются),
 * path traversal в account отсекается ДО записи файла.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { accountParam } from '../auth-tools.js';
import { CONFIG_DIR, envKey, hasRealEnvOverride, maskSecret, saveEnvValues, validateAccount } from '../config.js';
import { envOr } from '../env.js';
import { fetchJson } from '../http.js';
import { jsonResult, safeHandler } from '../mcp.js';
import type { GoogleAuth } from './auth.js';
import { saJsonFileName } from './auth.js';
import { createLoopbackManager, type OauthFlow } from './loopback.js';

export interface GoogleOauthToolsOptions {
  /** префикс инструментов: 'gsc' | 'ga4' */
  prefix: string;
  /** OAuth scope запрашиваемого доступа */
  scope: string;
  /** env с refresh-токеном (GSC_REFRESH_TOKEN) */
  refreshEnv: string;
  /** env с путём к JSON-ключу сервис-аккаунта (GSC_SA_JSON) */
  saJsonEnv: string;
  /** порт loopback-приёмника (обычно из process.env <PREFIX>_OAUTH_PORT) */
  port: number;
  /** имя env-переменной порта — для подсказки, когда порт занят */
  portEnv: string;
  /** авторизация сервера (нужны clientCreds + сброс кешей после сохранения) */
  auth: GoogleAuth;
  /** что за доступ выдаётся — в описании oauth_start («ко всем свойствам GSC») */
  accessSummary: string;
  /** какой API включить в Cloud Console (для подсказки при отсутствии клиента) */
  apiName: string;
  /** инструмент проверки после авторизации (gsc_list_sites / ga4_list_properties) */
  checkTool: string;
  /** что сделать с email сервис-аккаунта (доменная инструкция) */
  saNextHint: string;
}

export function registerGoogleOauthTools(server: McpServer, opts: GoogleOauthToolsOptions): void {
  const { prefix, auth } = opts;
  const redirectUri = `http://localhost:${opts.port}`;

  // ── Loopback-приёмник кода OAuth: ловит редирект Google на localhost ──
  // Код привязан к конкретному flow (state + профиль) — чужой/устаревший код не подхватится.
  let pendingFlow: OauthFlow | null = null;
  const { start: startLoopback, stop: stopLoopback } = createLoopbackManager({
    port: opts.port,
    redirectUri,
    getFlow: () => pendingFlow,
    toolPrefix: prefix, // страница в браузере должна звать инструмент ЭТОГО сервера
  });

  server.registerTool(
    `${prefix}_oauth_start`,
    {
      description:
        'Шаг 1 OAuth-авторизации Google: вернёт ссылку — пользователь открывает её под нужным Google-аккаунтом ' +
        `и разрешает read-only доступ. Полученный токен видит ${opts.accessSummary}. ` +
        'Требуется OAuth client типа Desktop app (client ID + secret из console.cloud.google.com); переданные clientId/clientSecret сохраняются ' +
        '(при account — в профиль GOOGLE_CLIENT_*__<account>, базовые значения не перезаписываются). ' +
        `После согласия Google отправит браузер на localhost — код подхватится автоматически, затем вызвать ${prefix}_oauth_finish.`,
      // НЕ read-only: сохраняет client id/secret
      annotations: { readOnlyHint: false },
      inputSchema: {
        clientId: z.string().optional().describe('OAuth client ID (если не сохранён как GOOGLE_CLIENT_ID)'),
        clientSecret: z.string().optional().describe('OAuth client secret'),
        account: accountParam,
      },
    },
    safeHandler(async (args) => {
      const values: Record<string, string> = {};
      if (args.clientId) values[envKey('GOOGLE_CLIENT_ID', args.account)] = args.clientId.trim();
      if (args.clientSecret) values[envKey('GOOGLE_CLIENT_SECRET', args.account)] = args.clientSecret.trim();
      // GOOGLE_CLIENT_* общие для всех Google-серверов (gsc, ga4) в одном env-файле:
      // подмена клиента ломает refresh-токены, выданные прежним client_id (Google ответит
      // invalid_grant, а его текст уводит на «переавторизуйся», не называя причину).
      // ВАЖНО: читаем прежнее значение ДО saveEnvValues, иначе сравнивали бы с только что записанным.
      // Если ключ перекрыт реальным окружением процесса, запись в файл не вступит в силу —
      // клиент фактически не меняется, и предупреждение было бы ложным (для этого случая
      // ниже отдаётся отдельный warning про override).
      const prevClientId = args.clientId ? envOr('GOOGLE_CLIENT_ID', args.account) : undefined;
      const clientOverridden = hasRealEnvOverride('GOOGLE_CLIENT_ID', args.account);
      const clientRotated = Boolean(prevClientId && prevClientId !== args.clientId?.trim() && !clientOverridden);
      if (Object.keys(values).length) saveEnvValues(values);
      const clientId = envOr('GOOGLE_CLIENT_ID', args.account);
      if (!clientId || !envOr('GOOGLE_CLIENT_SECRET', args.account)) {
        return jsonResult({
          ready: false,
          action:
            'Сначала создай OAuth client в console.cloud.google.com (APIs & Services → Credentials → OAuth client ID → Desktop app; ' +
            `перед этим включить ${opts.apiName} и настроить OAuth consent screen) и передай clientId + clientSecret в этот инструмент.`,
        });
      }
      // новый flow: свежий state, прежний пойманный код (если был) сбрасывается
      pendingFlow = { account: args.account ?? null, state: randomUUID(), code: null };
      const listenerOk = await startLoopback();
      const qs = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: opts.scope,
        access_type: 'offline', // нужен refresh-токен
        prompt: 'consent',
        state: pendingFlow.state, // привязка кода к этому flow/профилю
      });
      return jsonResult({
        ready: true,
        account: args.account ?? null,
        authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?${qs}`,
        next: listenerOk
          ? 'Пользователь открывает ссылку' +
            (args.account ? ` под Google-аккаунтом профиля «${args.account}»` : '') +
            `, разрешает доступ — браузер редиректнется на localhost и код будет подхвачен. Затем вызвать ${prefix}_oauth_finish` +
            (args.account ? ` с account="${args.account}"` : ' без аргументов') +
            '.'
          : `Порт ${opts.port} занят (другой процесс?): после согласия скопировать параметр code из адресной строки (localhost:${opts.port}/?code=...) и передать в ${prefix}_oauth_finish. Либо задать другой порт через ${opts.portEnv}.`,
        ...(Object.keys(values).length
          ? {
              credentialsSaved: Object.keys(values),
              note: args.account
                ? `clientId/clientSecret сохранены как ${Object.keys(values).join(', ')} (профиль «${args.account}») — базовые GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET не перезаписаны.`
                : 'clientId/clientSecret сохранены в базовые GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET.',
            }
          : {}),
        ...(clientOverridden && args.clientId
          ? {
              warning:
                `Ключ ${envKey('GOOGLE_CLIENT_ID', args.account)} перекрыт реальным окружением процесса (claude mcp add --env) — ` +
                'переданный clientId сохранён в файл, но авторизация пойдёт со СТАРЫМ значением из окружения. Убери override, чтобы новый клиент заработал.',
            }
          : {}),
        ...(clientRotated
          ? {
              warning:
                `Заменён OAuth-клиент в ${envKey('GOOGLE_CLIENT_ID', args.account)} — он ОБЩИЙ для всех Google-серверов (gsc, ga4). ` +
                'Refresh-токены, выданные прежним client_id, перестанут работать (Google ответит invalid_grant) — ' +
                'после этой авторизации переавторизуй и остальные Google-серверы, либо верни прежний clientId.',
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    `${prefix}_oauth_finish`,
    {
      description:
        'Шаг 2 OAuth-авторизации Google: обменивает код на access+refresh токены и сохраняет их. ' +
        `Без аргументов берёт код, пойманный localhost-приёмником после ${prefix}_oauth_start; можно передать код вручную.`,
      // НЕ read-only: сохраняет refresh-токен
      annotations: { readOnlyHint: false },
      inputSchema: {
        code: z.string().optional().describe('Код из редиректа (обычно не нужен — подхватывается автоматически)'),
        account: accountParam,
      },
    },
    safeHandler(async (args) => {
      const account = args.account ?? null;
      // защита от подмены профиля: пойманный код принадлежит flow конкретного account
      if (pendingFlow && account !== pendingFlow.account) {
        throw new Error(
          `Текущая авторизация запущена для профиля «${pendingFlow.account ?? 'основной'}», а finish вызван с «${account ?? 'основной'}». ` +
            `Заверши тот flow или повтори ${prefix}_oauth_start с нужным account.`,
        );
      }
      const code = args.code?.trim() || pendingFlow?.code;
      if (!code) {
        throw new Error(`Код не получен: сначала ${prefix}_oauth_start и авторизация в браузере (или передай code вручную).`);
      }
      const { clientId, clientSecret } = auth.clientCreds(args.account);
      const data = await fetchJson<{ access_token: string; refresh_token?: string; expires_in?: number }>(
        'https://oauth2.googleapis.com/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
          }).toString(),
        },
      );
      stopLoopback();
      pendingFlow = null;
      if (!data.refresh_token) {
        throw new Error(`Google не вернул refresh_token (повтори ${prefix}_oauth_start — там стоит prompt=consent — и согласись заново).`);
      }
      const refreshEnvKey = envKey(opts.refreshEnv, args.account);
      saveEnvValues({ [refreshEnvKey]: data.refresh_token });
      auth.resetCaches();
      return jsonResult({
        ok: true,
        account,
        refreshToken: maskSecret(data.refresh_token),
        note: `Токен даёт ${opts.accessSummary}. Если OAuth-приложение в статусе Testing — refresh живёт 7 дней (Publish app в consent screen решает). Проверка — ${opts.checkTool}.`,
        ...(hasRealEnvOverride(opts.refreshEnv, args.account)
          ? {
              warning: `Ключ ${refreshEnvKey} перекрыт реальным окружением процесса (claude mcp add --env) — сохранённое в файл значение вступит в силу только после удаления override.`,
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    `${prefix}_save_sa_json`,
    {
      description:
        `Сохранить содержимое JSON-ключа сервис-аккаунта в конфиг-директорию (права 600) и прописать ${opts.saJsonEnv}. ` +
        `Альтернатива, если файл уже лежит на диске: ${prefix}_set_credentials с путём в ${opts.saJsonEnv}.`,
      // НЕ read-only: пишет файл ключа
      annotations: { readOnlyHint: false },
      inputSchema: {
        json: z.string().describe('Полное содержимое скачанного JSON-ключа сервис-аккаунта'),
        account: accountParam,
      },
    },
    safeHandler(async (args) => {
      const account = validateAccount(args.account); // ПЕРВОЙ строкой: '../../tmp/x' — path traversal, отклоняем ДО любой записи файла
      let parsed: { client_email?: string; private_key?: string };
      try {
        parsed = JSON.parse(args.json);
      } catch {
        throw new Error('Невалидный JSON — передай содержимое файла ключа сервис-аккаунта целиком');
      }
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error('JSON не похож на ключ сервис-аккаунта (нет client_email/private_key)');
      }
      const file = join(CONFIG_DIR, saJsonFileName(prefix, account));
      writeFileSync(file, args.json, { mode: 0o600 });
      chmodSync(file, 0o600);
      const saEnvKey = envKey(opts.saJsonEnv, account);
      saveEnvValues({ [saEnvKey]: file });
      auth.resetCaches();
      return jsonResult({
        ok: true,
        savedTo: file,
        serviceAccountEmail: parsed.client_email,
        next: opts.saNextHint,
        ...(hasRealEnvOverride(opts.saJsonEnv, account)
          ? {
              warning: `Ключ ${saEnvKey} перекрыт реальным окружением процесса (claude mcp add --env) — сохранённое в файл значение вступит в силу только после удаления override.`,
            }
          : {}),
      });
    }),
  );
}
