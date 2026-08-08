/** Чистая логика gsc-сервера — вынесена из index.ts для юнит-тестов (без сети и поднятия сервера). */

import { getConfig } from '@seo-tools/shared';

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

// isInvalidGrant / saJsonFileName / saKeyErrorText — общие для Google-серверов,
// живут в @seo-tools/shared/google (auth.ts) и покрыты tests/google-auth.test.ts.

/** Подсказка при 403 от Google API: почти всегда это «нет доступа к свойству» или не тот формат siteUrl. */
export function forbidden403Hint(siteUrl?: string): string {
  return (
    `Google вернул 403 (нет доступа${siteUrl ? ` к свойству «${siteUrl}»` : ''}). ` +
    'Проверь список доступных свойств: gsc_list_sites; уровень доступа — gsc_get_site. ' +
    'Форматы siteUrl: sc-domain:example.com или URL-prefix с завершающим «/» (https://example.com/). ' +
    'Для сервис-аккаунта: его email добавлен в свойство (Настройки → Пользователи и права)?'
  );
}

// ── dimensionFilterGroups / aggregationType (searchanalytics.query) ──

/** Измерения, по которым GSC позволяет фильтровать (date/hour фильтрами не поддерживаются). */
export type GscFilterDimension = 'query' | 'page' | 'country' | 'device' | 'searchAppearance';

/** Операторы фильтра dimensionFilterGroups[].filters[] (searchanalytics.query). */
export type GscFilterOperator = 'equals' | 'notEquals' | 'contains' | 'notContains' | 'includingRegex' | 'excludingRegex';

export interface GscFilterInput {
  dimension: GscFilterDimension;
  operator: GscFilterOperator;
  expression: string;
}

// Ограничения официального API (developers.google.com/webmaster-tools/v1/searchanalytics/query):
// contains/notContains/includingRegex/excludingRegex применимы только к query и page;
// для country/device/searchAppearance — только equals/notEquals.
const TEXT_OPERATORS: ReadonlySet<GscFilterOperator> = new Set(['contains', 'notContains', 'includingRegex', 'excludingRegex']);
const TEXT_DIMENSIONS: ReadonlySet<GscFilterDimension> = new Set(['query', 'page']);

/** Валидация совместимости dimension×operator ДО запроса к API — с понятной ошибкой. */
export function validateFilters(filters: GscFilterInput[]): void {
  for (const f of filters) {
    if (TEXT_OPERATORS.has(f.operator) && !TEXT_DIMENSIONS.has(f.dimension)) {
      throw new Error(
        `Оператор «${f.operator}» применим только к query и page, а не к «${f.dimension}»: ` +
          'по документации GSC API для country/device/searchAppearance доступны только equals/notEquals.',
      );
    }
  }
}

/**
 * Сборка dimensionFilterGroups: старый параметр page (точный equals-фильтр) и произвольные
 * filters мержатся в ОДНУ группу (между фильтрами группы — AND, groupType 'and').
 * Нечего фильтровать → undefined (поле в тело запроса не добавляется).
 */
export function buildFilterGroups(
  page?: string,
  filters?: GscFilterInput[],
): Array<{ groupType: 'and'; filters: GscFilterInput[] }> | undefined {
  if (filters?.length) validateFilters(filters);
  const all: GscFilterInput[] = [];
  if (page) all.push({ dimension: 'page', operator: 'equals', expression: page });
  if (filters) all.push(...filters);
  if (!all.length) return undefined;
  return [{ groupType: 'and', filters: all }];
}

export interface QueryBodyArgs {
  startDate: string;
  endDate: string;
  dimensions: string[];
  searchType: string;
  dataState: string;
  page?: string;
  filters?: GscFilterInput[];
  /** auto | byProperty | byPage; по умолчанию (и при 'auto') поле в тело не добавляется. */
  aggregationType?: string;
}

/**
 * Тело searchanalytics.query. aggregationType уходит только при явном byProperty/byPage
 * ('auto' — дефолт API, слать не нужно). Внимание: фильтр/группировка по page несовместимы
 * с byProperty — API вернёт ошибку (не валидируем, сочетание осмысленно редко).
 */
export function buildQueryBody(args: QueryBodyArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {
    startDate: args.startDate,
    endDate: args.endDate,
    dimensions: args.dimensions,
    type: args.searchType,
    dataState: args.dataState,
  };
  const groups = buildFilterGroups(args.page, args.filters);
  if (groups) body.dimensionFilterGroups = groups;
  if (args.aggregationType && args.aggregationType !== 'auto') body.aggregationType = args.aggregationType;
  return body;
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
