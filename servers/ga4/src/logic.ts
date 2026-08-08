/** Чистая логика ga4-сервера — вынесена из index.ts для юнит-тестов (без сети и поднятия сервера). */

import { getConfig } from '@seo-tools/shared';

/** Ресурс свойства GA4: явный аргумент или GA4_PROPERTY_ID (с суффиксом профиля) из конфига. */
export function resolveProperty(propertyId?: string, account?: string): string {
  const raw = (propertyId || getConfig('GA4_PROPERTY_ID', account) || '').trim();
  if (!raw) {
    throw new Error(
      `Не указано свойство GA4${account ? ` для аккаунта «${account}»` : ''}: передай propertyId (числовой id, например 123456789) ` +
        'или сохрани дефолт через ga4_set_credentials' +
        (account ? ` (account="${account}")` : ' (GA4_PROPERTY_ID)') +
        '. Список доступных — ga4_list_properties.',
    );
  }
  // принимаем и «123456789», и «properties/123456789»
  const id = raw.startsWith('properties/') ? raw.slice('properties/'.length) : raw;
  if (!/^\d+$/.test(id)) {
    throw new Error(
      `Некорректный propertyId «${raw}»: ожидается числовой id свойства GA4 (например 123456789) или «properties/123456789». ` +
        'Это НЕ Measurement ID (G-XXXXXXX) и не номер счётчика — точный id смотри в ga4_list_properties.',
    );
  }
  return `properties/${id}`;
}

/** Дата GA4: YYYY-MM-DD либо относительные ключевые слова (today, yesterday, NdaysAgo). */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEYWORD_RE = /^(today|yesterday|\d+daysAgo)$/;

export function validateDate(value: string, field: string): void {
  if (!DATE_RE.test(value) && !KEYWORD_RE.test(value)) {
    throw new Error(
      `Некорректная дата ${field}="${value}": ожидается YYYY-MM-DD либо ключевое слово GA4 (today, yesterday, NdaysAgo — например 28daysAgo).`,
    );
  }
}

/**
 * Проверка порядка дат. Сравниваем только когда ОБЕ границы абсолютные (YYYY-MM-DD):
 * ключевые слова резолвит сам GA4 в таймзоне свойства, и локально их сравнивать некорректно.
 */
export function validateDateRange(startDate: string, endDate: string): void {
  validateDate(startDate, 'startDate');
  validateDate(endDate, 'endDate');
  if (DATE_RE.test(startDate) && DATE_RE.test(endDate) && startDate > endDate) {
    throw new Error(`startDate (${startDate}) позже endDate (${endDate}) — поменяй границы местами.`);
  }
}

/** Оператор строкового фильтра Data API (stringFilter.matchType). */
export type Ga4MatchType = 'EXACT' | 'BEGINS_WITH' | 'ENDS_WITH' | 'CONTAINS' | 'FULL_REGEXP' | 'PARTIAL_REGEXP';

export interface Ga4FilterInput {
  /** имя измерения, например pagePath, sessionSourceMedium */
  dimension: string;
  matchType: Ga4MatchType;
  value: string;
  /** учитывать регистр (по умолчанию false) */
  caseSensitive?: boolean;
  /** инвертировать условие (NOT) */
  not?: boolean;
}

/**
 * dimensionFilter для runReport: несколько фильтров объединяются AND (andGroup).
 * Нечего фильтровать → undefined (поле в тело запроса не добавляется).
 */
export function buildDimensionFilter(filters?: Ga4FilterInput[]): Record<string, unknown> | undefined {
  if (!filters?.length) return undefined;
  const expressions = filters.map((f) => {
    const expr: Record<string, unknown> = {
      filter: {
        fieldName: f.dimension,
        stringFilter: { matchType: f.matchType, value: f.value, caseSensitive: Boolean(f.caseSensitive) },
      },
    };
    return f.not ? { notExpression: expr } : expr;
  });
  // один фильтр не заворачиваем в группу — так тело запроса проще и читаемее в логах
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

export interface ReportBodyArgs {
  startDate: string;
  endDate: string;
  dimensions: string[];
  metrics: string[];
  filters?: Ga4FilterInput[];
  /** метрика сортировки (по убыванию, если orderDesc не false) */
  orderBy?: string;
  orderDesc?: boolean;
  limit: number;
  offset?: number;
  /** возвращать строки с нулями (по умолчанию GA4 их скрывает) */
  keepEmptyRows?: boolean;
}

/** Тело properties.runReport. */
export function buildReportBody(args: ReportBodyArgs): Record<string, unknown> {
  validateDateRange(args.startDate, args.endDate);
  if (!args.metrics.length) throw new Error('Не заданы метрики: укажи хотя бы одну (например activeUsers, sessions, screenPageViews).');
  const body: Record<string, unknown> = {
    dateRanges: [{ startDate: args.startDate, endDate: args.endDate }],
    dimensions: args.dimensions.map((name) => ({ name })),
    metrics: args.metrics.map((name) => ({ name })),
    limit: args.limit,
  };
  if (args.offset) body.offset = args.offset;
  if (args.keepEmptyRows) body.keepEmptyRows = true;
  const filter = buildDimensionFilter(args.filters);
  if (filter) body.dimensionFilter = filter;
  if (args.orderBy) {
    // сортировка по метрике, если она есть в списке метрик, иначе по измерению
    const isMetric = args.metrics.includes(args.orderBy);
    body.orderBys = [
      {
        ...(isMetric ? { metric: { metricName: args.orderBy } } : { dimension: { dimensionName: args.orderBy } }),
        desc: args.orderDesc !== false,
      },
    ];
  }
  return body;
}

export interface Ga4ReportRow {
  [key: string]: string | number;
}

export interface ParsedReport {
  rows: Ga4ReportRow[];
  count: number;
  /** rowCount ответа — всего строк, доступных по запросу (может быть больше limit) */
  totalRows: number | null;
  /** true — строк больше, чем вернули (обрезано по limit) */
  truncated: boolean;
  /** таймзона свойства (даты GA4 считаются в ней, не в UTC/MSK) */
  timeZone: string | null;
  currency: string | null;
  /** true — в отчёте применён порог конфиденциальности: часть данных скрыта */
  thresholded: boolean;
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

/**
 * Ответ runReport/runRealtimeReport → плоские строки {измерение: значение, метрика: число}.
 * Метрики Data API приходят строками — приводим к числам; заголовки берём из ответа,
 * поэтому порядок и имена всегда соответствуют реально возвращённым колонкам.
 */
export function parseReport(data: any, limit?: number): ParsedReport {
  const dimHeaders: string[] = (data?.dimensionHeaders ?? []).map((h: any) => String(h?.name ?? ''));
  const metricHeaders: string[] = (data?.metricHeaders ?? []).map((h: any) => String(h?.name ?? ''));
  const rawRows: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const rows: Ga4ReportRow[] = rawRows.map((r) => {
    const out: Ga4ReportRow = {};
    (r?.dimensionValues ?? []).forEach((v: any, i: number) => {
      out[dimHeaders[i] ?? `dimension${i}`] = String(v?.value ?? '');
    });
    (r?.metricValues ?? []).forEach((v: any, i: number) => {
      out[metricHeaders[i] ?? `metric${i}`] = num(v?.value);
    });
    return out;
  });
  const totalRows = data?.rowCount != null ? num(data.rowCount) : null;
  return {
    rows,
    count: rows.length,
    totalRows,
    truncated: totalRows != null && limit != null ? totalRows > rows.length : false,
    timeZone: data?.metadata?.timeZone ? String(data.metadata.timeZone) : null,
    currency: data?.metadata?.currencyCode ? String(data.metadata.currencyCode) : null,
    thresholded: Boolean(data?.metadata?.subjectToThresholding),
  };
}

export interface Ga4Property {
  /** ресурс вида properties/123456789 */
  property: string;
  propertyId: string;
  displayName: string;
  account: string;
  accountName: string;
}

/** accountSummaries (Admin API) → плоский список свойств. */
export function flattenAccountSummaries(data: any): Ga4Property[] {
  const summaries: any[] = Array.isArray(data?.accountSummaries) ? data.accountSummaries : [];
  const out: Ga4Property[] = [];
  for (const acc of summaries) {
    const account = String(acc?.account ?? '');
    const accountName = String(acc?.displayName ?? '');
    for (const p of Array.isArray(acc?.propertySummaries) ? acc.propertySummaries : []) {
      const property = String(p?.property ?? '');
      if (!property) continue;
      out.push({
        property,
        propertyId: property.replace(/^properties\//, ''),
        displayName: String(p?.displayName ?? ''),
        account,
        accountName,
      });
    }
  }
  return out;
}

/** Подсказка при 403 от Google Analytics API. */
export function forbidden403Hint(property?: string): string {
  return (
    `Google вернул 403 (нет доступа${property ? ` к свойству «${property}»` : ''}). ` +
    'Проверь список доступных свойств: ga4_list_properties. ' +
    'Для сервис-аккаунта: его email добавлен в свойство GA4 (Администратор → Управление доступом к ресурсу, роль «Просмотр»)? ' +
    'Также убедись, что в проекте Google Cloud включены Google Analytics Data API и Google Analytics Admin API.'
  );
}
