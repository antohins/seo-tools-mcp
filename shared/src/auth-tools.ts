/**
 * Фабрика универсальных auth-инструментов для каждого сервера:
 *  - <prefix>_auth_status  — что задано/чего не хватает + инструкция получения;
 *  - <prefix>_set_credentials — сохранить ключи в конфиг и применить без перезапуска.
 *
 * Задуманный flow в новой сессии: агент вызывает auth_status → видит missing →
 * спрашивает значения у пользователя в чате → set_credentials → работает дальше.
 * Готовность (ready) учитывает и основной профиль, и именованные аккаунты.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult, safeHandler } from './mcp.js';
import { saveEnvValues, maskSecret, ENV_FILE, envKey, accountsFor, getConfig, hasRealEnvOverride, readConfigFile } from './config.js';

/** Общий zod-параметр account для рабочих инструментов всех серверов. */
export const accountParam = z.string().optional()
  .describe('Аккаунт-профиль (мультиаккаунт, см. *_auth_status); пусто = основной');

export interface CredSpec {
  /** имя env-переменной */
  env: string;
  /** человекочитаемое описание (что это и где взять) */
  label: string;
  /** секрет маскируется в статусе (default true) */
  secret?: boolean;
  /** обязателен для работы сервера (default true) */
  required?: boolean;
}

export interface AuthToolsOptions {
  /** инструкция: как получить доступы (шаги регистрации) */
  help: string;
  /** группы альтернатив: в каждой группе должен быть задан ХОТЯ БЫ ОДИН env */
  requireAnyOf?: string[][];
  /** колбэк после сохранения (сброс кешей клиентов и т.п.) */
  onSave?: () => void;
}

export function registerAuthTools(server: McpServer, prefix: string, creds: CredSpec[], opts: AuthToolsOptions): void {
  /** Готов ли профиль account (undefined = основной): required-креды + anyOf-группы. */
  const profileReady = (account?: string): boolean => {
    const requiredOk = creds
      .filter((c) => c.required !== false)
      .every((c) => Boolean(getConfig(c.env, account)));
    const groupsOk = (opts.requireAnyOf ?? [])
      .every((group) => group.some((env) => Boolean(getConfig(env, account))));
    return requiredOk && groupsOk;
  };

  server.registerTool(
    `${prefix}_auth_status`,
    {
      description:
        `Статус авторизации ${prefix}: какие ключи заданы (маскированно), каких не хватает, как их получить. ` +
        `ВЫЗЫВАТЬ ПЕРВЫМ в начале работы с ${prefix}. Если чего-то нет — запросить значения у пользователя ` +
        `и сохранить через ${prefix}_set_credentials.`,
      inputSchema: {},
    },
    safeHandler(async () => {
      readConfigFile(true); // свежий взгляд на конфиг
      const credentials = creds.map((c) => {
        const perAccount: Record<string, string | null> = {};
        for (const acc of accountsFor(c.env)) {
          const v = getConfig(c.env, acc);
          perAccount[acc] = c.secret === false ? (v ?? null) : maskSecret(v);
        }
        return {
          env: c.env,
          label: c.label,
          required: c.required !== false,
          set: Boolean(getConfig(c.env)),
          value: c.secret === false ? (getConfig(c.env) ?? null) : maskSecret(getConfig(c.env)),
          ...(Object.keys(perAccount).length ? { accounts: perAccount } : {}),
        };
      });

      const missing: string[] = credentials.filter((s) => s.required && !s.set).map((s) => s.env);
      for (const group of opts.requireAnyOf ?? []) {
        if (!group.some((env) => Boolean(getConfig(env)))) {
          missing.push(group.join(' | ')); // достаточно любого из группы
        }
      }

      const allAccounts = [...new Set(creds.flatMap((c) => accountsFor(c.env)))].sort();
      const readyAccounts = allAccounts.filter((acc) => profileReady(acc));
      const baseReady = missing.length === 0;

      return jsonResult({
        // готов, если работоспособен основной профиль ИЛИ хотя бы один именованный
        ready: baseReady || readyAccounts.length > 0,
        baseProfileReady: baseReady,
        missing, // чего не хватает ОСНОВНОМУ профилю
        readyAccounts,
        accounts: allAccounts,
        credentials,
        multiAccount:
          'Мультиаккаунт: рабочие инструменты принимают параметр account; ключи профилей хранятся как ИМЯ__<account> ' +
          `(сохранять через ${prefix}_set_credentials c account=...). Без account используется основной профиль.`,
        envFile: ENV_FILE,
        howToGet: opts.help,
      });
    }),
  );

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const c of creds) shape[c.env] = z.string().optional().describe(c.label);
  shape.account = z.string().optional()
    .describe('Имя аккаунта-профиля (мультиаккаунт): ключи сохранятся с суффиксом __<account>');

  server.registerTool(
    `${prefix}_set_credentials`,
    {
      description:
        `Сохранить ключи ${prefix} в ${ENV_FILE} (права 600) и применить сразу, без перезапуска сервера. ` +
        'Передавать только обновляемые поля. account — сохранить в именованный профиль (мультиаккаунт). ' +
        'Значения даёт пользователь; в ответе они маскируются.',
      inputSchema: shape,
    },
    safeHandler(async (args: Record<string, string | undefined>) => {
      const values: Record<string, string> = {};
      const overridden: string[] = [];
      for (const c of creds) {
        const v = args[c.env];
        if (v && v.trim()) {
          values[envKey(c.env, args.account)] = v.trim();
          if (hasRealEnvOverride(c.env, args.account)) overridden.push(envKey(c.env, args.account));
        }
      }
      if (!Object.keys(values).length) return jsonResult({ saved: [], note: 'ничего не передано' });
      const file = saveEnvValues(values);
      opts.onSave?.();
      return jsonResult({
        saved: Object.keys(values),
        account: args.account ?? null,
        envFile: file,
        ...(overridden.length
          ? { warning: `Ключи ${overridden.join(', ')} перекрыты реальным окружением процесса (claude mcp add --env) — сохранённое в файл значение вступит в силу только после удаления override.` }
          : {}),
      });
    }),
  );
}
