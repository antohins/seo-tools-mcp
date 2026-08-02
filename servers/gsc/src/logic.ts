/** Чистая логика gsc-сервера — вынесена из index.ts для юнит-тестов (без сети и поднятия сервера). */

import { getConfig, HttpError, validateAccount } from '@seo-tools/shared';

/** Строка ответа Search Analytics API. */
export interface GscRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Свойство GSC: явный аргумент или GSC_SITE_URL (с суффиксом профиля) из конфига. */
export function resolveSite(siteUrl?: string, account?: string): string {
  const site = siteUrl || getConfig('GSC_SITE_URL', account);
  if (!site) {
    throw new Error(
      `Не указано свойство GSC${account ? ` для аккаунта «${account}»` : ''}: передай siteUrl (например sc-domain:example.com) ` +
        'или сохрани дефолт через gsc_set_credentials' +
        (account ? ` (account="${account}")` : ' (GSC_SITE_URL)') +
        '. Список доступных — gsc_list_sites.',
    );
  }
  return site;
}

/** Валидация диапазона дат (строки YYYY-MM-DD корректно сравниваются лексикографически). */
export function validateDates(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new Error(`startDate (${startDate}) позже endDate (${endDate}) — поменяй границы местами.`);
  }
}

/** true — Google отверг refresh-токен (invalid_grant): токен отозван или истёк, нужна переавторизация. */
export function isInvalidGrant(err: unknown): boolean {
  return err instanceof HttpError && err.bodySnippet.includes('invalid_grant');
}

/**
 * Имя файла SA-ключа внутри CONFIG_DIR. account валидируется ДО склейки пути:
 * '../../tmp/x' отклоняется здесь (path traversal), а не позже в saveEnvValues.
 */
export function saJsonFileName(account?: string): string {
  const acc = validateAccount(account);
  return acc ? `gsc-sa__${acc}.json` : 'gsc-sa.json';
}

/** Подсказка при 403 от Google API: почти всегда это «нет доступа к свойству» или не тот формат siteUrl. */
export function forbidden403Hint(siteUrl?: string): string {
  return (
    `Google вернул 403 (нет доступа${siteUrl ? ` к свойству «${siteUrl}»` : ''}). ` +
    'Проверь список доступных свойств: gsc_list_sites; уровень доступа — gsc_get_site. ' +
    'Форматы siteUrl: sc-domain:example.com или URL-prefix с завершающим «/» (https://example.com/). ' +
    'Для сервис-аккаунта: его email добавлен в свойство (Настройки → Пользователи и права)?'
  );
}

/** Текст ошибки чтения/использования JSON-ключа сервис-аккаунта (битый путь, битый ключ) с адресацией на починку. */
export function saKeyErrorText(keyFile: string, err: unknown): string {
  return (
    `Не удалось получить токен по ключу сервис-аккаунта (${keyFile}): ${err instanceof Error ? err.message : String(err)}. ` +
    'Проверь путь GSC_SA_JSON (gsc_auth_status); обновить ключ — gsc_save_sa_json / gsc_set_credentials.'
  );
}

/** Разворачивает keys[] строки Search Analytics в именованные dimensions ({query: '…', device: '…'}). */
export function mapKeysToDimensions(row: GscRow, dimensions: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  };
  (row.keys ?? []).forEach((key, i) => {
    out[dimensions[i] ?? `key${i}`] = key;
  });
  return out;
}
