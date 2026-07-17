import { accountsFor, envKey, getConfig, readConfigFile } from './config.js';

/**
 * Прогрев кеша конфига. Исторически мержила файл в process.env — больше НЕ мержит:
 * источник истины — файл (читается свежим через getConfig), приоритет — только
 * реальное окружение процесса (снапшот initialEnv в config.ts).
 */
export function loadSharedEnv(): void {
  readConfigFile(true);
}

/**
 * Достаёт обязательное значение конфига; бросает понятную ошибку, если нет.
 * account — именованный профиль (мультиаккаунт): читается NAME__account, СТРОГО
 * без фолбэка на основной ключ (чтобы не уйти молча в чужой аккаунт).
 */
export function requireEnv(name: string, account?: string): string {
  let value = getConfig(name, account);
  if (!value) {
    // страховка от записи в ту же миллисекунду (mtime не изменился) — форс-чтение
    readConfigFile(true);
    value = getConfig(name, account);
  }
  if (!value) {
    const known = accountsFor(name);
    throw new Error(
      `Не задана переменная окружения ${envKey(name, account)}.` +
        (account ? ` Настроенные аккаунты для ${name}: ${known.length ? known.join(', ') : 'ни одного'}.` : '') +
        ` Сохрани через <server>_set_credentials${account ? ` с account="${account}"` : ''} или в env-файл конфига.`,
    );
  }
  return value;
}

/**
 * Значение с мягким фолбэком: NAME__account → NAME. ТОЛЬКО для «общих» настроек,
 * одинаковых у всех профилей (client_id/secret OAuth-приложения). Для per-профильных
 * данных (токены, счётчики, хосты, origin) использовать getConfig/requireEnv строго.
 */
export function envOr(name: string, account?: string): string | undefined {
  return getConfig(name, account) ?? getConfig(name);
}
