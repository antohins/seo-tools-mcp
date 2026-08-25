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
  /** второй период для сравнения (period-over-period) */
  compareStartDate?: string;
  compareEndDate?: string;
  /** фильтры по значениям метрик (metricFilter) */
  metricFilters?: Ga4MetricFilterInput[];
  /** добавить итоги по метрикам (metricAggregations: TOTAL) */
  includeTotals?: boolean;
  /** вернуть остаток квоты свойства (propertyQuota) */
  returnPropertyQuota?: boolean;
}

/** Числовой фильтр по метрике (metricFilter). */
export interface Ga4MetricFilterInput {
  metric: string;
  operation: 'EQUAL' | 'LESS_THAN' | 'LESS_THAN_OR_EQUAL' | 'GREATER_THAN' | 'GREATER_THAN_OR_EQUAL';
  value: number;
}

/** Значение для numericFilter: целые уходят int64Value (строкой), дробные — doubleValue. */
const numericValue = (v: number): Record<string, unknown> => (Number.isInteger(v) ? { int64Value: String(v) } : { doubleValue: v });

/** metricFilter: несколько условий объединяются AND. */
export function buildMetricFilter(filters?: Ga4MetricFilterInput[]): Record<string, unknown> | undefined {
  if (!filters?.length) return undefined;
  const expressions = filters.map((f) => ({
    filter: { fieldName: f.metric, numericFilter: { operation: f.operation, value: numericValue(f.value) } },
  }));
  return expressions.length === 1 ? expressions[0] : { andGroup: { expressions } };
}

/** Имена периодов в ответе при сравнении (GA4 добавляет колонку dateRange). */
export const RANGE_CURRENT = 'current';
export const RANGE_PREVIOUS = 'previous';

/** Тело properties.runReport. */
export function buildReportBody(args: ReportBodyArgs): Record<string, unknown> {
  validateDateRange(args.startDate, args.endDate);
  if (!args.metrics.length) throw new Error('Не заданы метрики: укажи хотя бы одну (например activeUsers, sessions, screenPageViews).');
  // Сравнение периодов: второй dateRange. GA4 сам добавит в строки колонку dateRange
  // со значениями-именами диапазонов — поэтому имена задаём осмысленные.
  const compare = args.compareStartDate && args.compareEndDate;
  if (args.compareStartDate || args.compareEndDate) {
    if (!compare) throw new Error('Для сравнения периодов нужны ОБА параметра: compareStartDate и compareEndDate.');
    validateDateRange(args.compareStartDate as string, args.compareEndDate as string);
  }
  const body: Record<string, unknown> = {
    dateRanges: compare
      ? [
          { startDate: args.startDate, endDate: args.endDate, name: RANGE_CURRENT },
          { startDate: args.compareStartDate, endDate: args.compareEndDate, name: RANGE_PREVIOUS },
        ]
      : [{ startDate: args.startDate, endDate: args.endDate }],
    dimensions: args.dimensions.map((name) => ({ name })),
    metrics: args.metrics.map((name) => ({ name })),
    limit: args.limit,
  };
  if (args.offset) body.offset = args.offset;
  if (args.keepEmptyRows) body.keepEmptyRows = true;
  if (args.includeTotals) body.metricAggregations = ['TOTAL'];
  if (args.returnPropertyQuota) body.returnPropertyQuota = true;
  const filter = buildDimensionFilter(args.filters);
  if (filter) body.dimensionFilter = filter;
  const mFilter = buildMetricFilter(args.metricFilters);
  if (mFilter) body.metricFilter = mFilter;
  if (args.orderBy) {
    // Классифицируем строго по запрошенным полям. Раньше «не метрика ⇒ измерение» отправляло
    // метрику, забытую в metrics, как dimension: API отвечал 400 «not a valid dimension»,
    // уводя от настоящей причины. GA4 требует, чтобы поле сортировки было в запросе.
    const isMetric = args.metrics.includes(args.orderBy);
    const isDimension = args.dimensions.includes(args.orderBy);
    if (!isMetric && !isDimension) {
      throw new Error(
        `orderBy="${args.orderBy}" не входит ни в metrics (${args.metrics.join(', ') || '—'}), ни в dimensions (${args.dimensions.join(', ') || '—'}): ` +
          'GA4 сортирует только по полям, запрошенным в этом же отчёте — добавь его в metrics/dimensions или убери orderBy.',
      );
    }
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
  /** true — за текущей страницей есть ещё строки (учитывает offset) */
  truncated: boolean;
  /** таймзона свойства (даты GA4 считаются в ней, не в UTC/MSK); у realtime поля НЕТ вовсе — там нет metadata */
  timeZone?: string | null;
  currency?: string | null;
  /** true — в отчёте применён порог конфиденциальности: часть данных скрыта */
  thresholded?: boolean;
  /** итоги по метрикам (только при includeTotals); при сравнении периодов — по строке на период */
  totals?: Ga4ReportRow[];
}

export interface ParseReportOptions {
  /** смещение текущей страницы — нужно, чтобы truncated не был ложноположительным */
  offset?: number;
  /**
   * false — у ответа нет блока metadata (runRealtimeReport): поля timeZone/currency/
   * thresholded не выдумываем, а вовсе не отдаём.
   */
  withMetadata?: boolean;
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
export function parseReport(data: any, opts: ParseReportOptions = {}): ParsedReport {
  const dimHeaders: string[] = (data?.dimensionHeaders ?? []).map((h: any) => String(h?.name ?? ''));
  const metricHeaders: string[] = (data?.metricHeaders ?? []).map((h: any) => String(h?.name ?? ''));
  /**
   * Одна строка ответа → плоский объект по заголовкам колонок.
   * dropPlaceholders (строки totals): у обычных измерений там служебные RESERVED_TOTAL,
   * но у колонки dateRange стоит РЕАЛЬНОЕ имя периода (current/previous) — без него нельзя
   * понять, к какому периоду относится итог, поэтому выбрасываем только заглушки.
   */
  const mapRow = (r: any, opts2: { dropPlaceholders?: boolean } = {}): Ga4ReportRow => {
    const out: Ga4ReportRow = {};
    (r?.dimensionValues ?? []).forEach((v: any, i: number) => {
      const value = String(v?.value ?? '');
      if (opts2.dropPlaceholders && (value === '' || /^RESERVED_/.test(value))) return;
      out[dimHeaders[i] ?? `dimension${i}`] = value;
    });
    (r?.metricValues ?? []).forEach((v: any, i: number) => {
      out[metricHeaders[i] ?? `metric${i}`] = num(v?.value);
    });
    return out;
  };
  const rawRows: any[] = Array.isArray(data?.rows) ? data.rows : [];
  const rows: Ga4ReportRow[] = rawRows.map((r) => mapRow(r));
  const totalRows = data?.rowCount != null ? num(data.rowCount) : null;
  const offset = opts.offset ?? 0;
  const out: ParsedReport = {
    rows,
    count: rows.length,
    totalRows,
    // учитываем offset: на последней странице (offset+rows === rowCount) обрезки нет,
    // иначе клиент зацикливал бы пагинацию, видя truncated=true на хвосте
    truncated: totalRows != null ? offset + rows.length < totalRows : false,
  };
  // итоги (metricAggregations: TOTAL). В totals-строке измерения — служебные
  // заглушки RESERVED_TOTAL, поэтому берём только метрики
  const rawTotals: any[] = Array.isArray(data?.totals) ? data.totals : [];
  if (rawTotals.length) out.totals = rawTotals.map((r) => mapRow(r, { dropPlaceholders: true }));
  // у runRealtimeReport блока metadata нет — не выдумываем пустышки
  if (opts.withMetadata !== false) {
    out.timeZone = data?.metadata?.timeZone ? String(data.metadata.timeZone) : null;
    out.currency = data?.metadata?.currencyCode ? String(data.metadata.currencyCode) : null;
    out.thresholded = Boolean(data?.metadata?.subjectToThresholding);
  }
  return out;
}

export interface Ga4Field {
  apiName: string;
  uiName: string;
  category: string;
  /** true — кастомное определение свойства (customEvent:… / customUser:…) */
  custom: boolean;
  /** тип метрики (TYPE_INTEGER/TYPE_FLOAT/TYPE_SECONDS/TYPE_CURRENCY…) — подсказывает формат значения в metricFilters */
  type?: string;
  /**
   * Причины блокировки поля на этом свойстве. Критично: по такой метрике отчёт вернёт
   * ОДНИ НУЛИ без ошибки, а запрос с metricFilters по ней упадёт с 400.
   */
  blockedReasons?: string[];
  description?: string;
}

export interface ParsedMetadata {
  dimensions: Ga4Field[];
  metrics: Ga4Field[];
  /** сколько полей подошло под фильтр (не путать с *InProperty) */
  matchedDimensions: number;
  matchedMetrics: number;
  /** сколько всего полей у свойства (до фильтрации) */
  dimensionsInProperty: number;
  metricsInProperty: number;
  /** обрезаны ли списки — раздельно, чтобы было понятно какой именно */
  dimensionsTruncated: boolean;
  metricsTruncated: boolean;
}

const mapField = (f: any, withDescription: boolean): Ga4Field => {
  const apiName = String(f?.apiName ?? '');
  const out: Ga4Field = {
    apiName,
    uiName: String(f?.uiName ?? ''),
    category: String(f?.category ?? ''),
    // customDefinition приходит не всегда; префикс — надёжный признак кастомного поля
    custom: Boolean(f?.customDefinition) || /^custom(Event|User|Item):/.test(apiName),
  };
  if (f?.type) out.type = String(f.type);
  if (Array.isArray(f?.blockedReasons) && f.blockedReasons.length) out.blockedReasons = f.blockedReasons.map(String);
  if (withDescription && f?.description) out.description = String(f.description);
  return out;
};

export interface MetadataFilter {
  /** подстрока для поиска по apiName/uiName/описанию (регистронезависимо) */
  search?: string;
  /** только кастомные определения свойства */
  customOnly?: boolean;
  /** сколько полей каждого типа вернуть */
  limit?: number;
  /** включать описания полей (по умолчанию нет — они раздувают ответ на десятки КБ) */
  withDescriptions?: boolean;
}

/**
 * Ответ properties.getMetadata → списки измерений и метрик свойства (включая кастомные).
 * У свойства их сотни (375 измерений / 119 метрик на живом аккаунте), поэтому список
 * фильтруется и обрезается: иначе ответ инструмента раздувается на десятки килобайт.
 */
export function parseMetadata(data: any, filter: MetadataFilter = {}): ParsedMetadata {
  const limit = filter.limit ?? 50;
  const q = filter.search?.trim().toLowerCase();
  const pick = (list: any[]): { total: number; matched: Ga4Field[]; shown: Ga4Field[] } => {
    const raw = Array.isArray(list) ? list : [];
    // поиск идёт и по описанию, поэтому маппим с описанием всегда, а отдаём — по флагу
    let matched = raw.map((f) => mapField(f, true));
    if (filter.customOnly) matched = matched.filter((f) => f.custom);
    if (q) {
      // ранжируем: совпадение в apiName важнее, чем в uiName, и намного важнее, чем в описании.
      // Без этого «landing» выдавал первыми cm360CampaignId и подобное — совпавшее лишь описанием,
      // а самого landingPage в начале списка не было.
      const rank = (f: Ga4Field): number => {
        if (f.apiName.toLowerCase().includes(q)) return 0;
        if (f.uiName.toLowerCase().includes(q)) return 1;
        if ((f.description ?? '').toLowerCase().includes(q)) return 2;
        return 3;
      };
      matched = matched
        .map((f, i) => ({ f, r: rank(f), i }))
        .filter((x) => x.r < 3)
        .sort((a, b) => a.r - b.r || a.i - b.i) // стабильно: внутри группы — исходный порядок API
        .map((x) => x.f);
    }
    const shown = matched.slice(0, limit).map((f) => {
      if (filter.withDescriptions) return f;
      const { description, ...rest } = f;
      return rest as Ga4Field;
    });
    return { total: raw.length, matched, shown };
  };
  const d = pick(data?.dimensions);
  const m = pick(data?.metrics);
  return {
    dimensions: d.shown,
    metrics: m.shown,
    matchedDimensions: d.matched.length,
    matchedMetrics: m.matched.length,
    dimensionsInProperty: d.total,
    metricsInProperty: m.total,
    dimensionsTruncated: d.matched.length > d.shown.length,
    metricsTruncated: m.matched.length > m.shown.length,
  };
}

export interface ParsedCompatibility {
  /** поля, которые МОЖНО ДОБАВИТЬ к проверяемому запросу, сохранив совместимость */
  canAddDimensions: string[];
  canAddMetrics: string[];
  canAddDimensionsTotal: number;
  canAddMetricsTotal: number;
  truncated: boolean;
}

/**
 * Ответ properties.checkCompatibility.
 *
 * ВАЖНО про контракт метода: он перечисляет поля, которые можно ДОБАВИТЬ к запросу с
 * сохранением совместимости, и ПАДАЕТ, если сама проверяемая связка несовместима. То есть
 * «мой набор валиден?» определяется фактом успеха вызова, а не содержимым ответа; в ответе
 * же приходят ДРУГИЕ поля свойства (их сотни), поэтому список обрезаем.
 */
export function parseCompatibility(data: any, limit = 40): ParsedCompatibility {
  const dims: string[] = [];
  const mets: string[] = [];
  for (const d of Array.isArray(data?.dimensionCompatibilities) ? data.dimensionCompatibilities : []) {
    const name = String(d?.dimensionMetadata?.apiName ?? '');
    if (name && d?.compatibility === 'COMPATIBLE') dims.push(name);
  }
  for (const m of Array.isArray(data?.metricCompatibilities) ? data.metricCompatibilities : []) {
    const name = String(m?.metricMetadata?.apiName ?? '');
    if (name && m?.compatibility === 'COMPATIBLE') mets.push(name);
  }
  return {
    canAddDimensions: dims.slice(0, limit),
    canAddMetrics: mets.slice(0, limit),
    canAddDimensionsTotal: dims.length,
    canAddMetricsTotal: mets.length,
    truncated: dims.length > limit || mets.length > limit,
  };
}

/** Из текста ошибки 400 достаём поля, которые GA4 просит убрать («Please remove X and Y…»). */
export function incompatibleFieldsFromError(message: string): string[] {
  const m = /Please remove\s+(.+?)\s+to make the request compatible/i.exec(message);
  if (!m) return [];
  return m[1]
    .split(/\s*(?:,|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
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

/** Шаг воронки: событие и/или условия по измерениям. */
export interface Ga4FunnelStepInput {
  name: string;
  /** имя события GA4 (page_view, add_to_cart, purchase…) */
  eventName?: string;
  /** дополнительные условия по измерениям — объединяются с событием через AND */
  filters?: Ga4FilterInput[];
  /** true — шаг должен идти СРАЗУ после предыдущего, без событий между ними */
  isDirectlyFollowedBy?: boolean;
  /** ограничение по времени от предыдущего шага (минуты) */
  withinMinutesFromPriorStep?: number;
}

/** Одно условие шага воронки → FunnelFilterExpression. */
function funnelFieldExpression(f: Ga4FilterInput): Record<string, unknown> {
  const expr = {
    funnelFieldFilter: {
      fieldName: f.dimension,
      stringFilter: { matchType: f.matchType, value: f.value, caseSensitive: Boolean(f.caseSensitive) },
    },
  };
  return f.not ? { notExpression: expr } : expr;
}

export interface FunnelBodyArgs {
  startDate: string;
  endDate: string;
  steps: Ga4FunnelStepInput[];
  /** false — закрытая воронка: учитываются только пользователи, вошедшие через ПЕРВЫЙ шаг */
  openFunnel?: boolean;
  /** измерение для разбивки таблицы воронки (например deviceCategory) */
  breakdownDimension?: string;
  breakdownLimit?: number;
  limit: number;
  /** фильтр по всему отчёту (не по шагу) */
  filters?: Ga4FilterInput[];
  returnPropertyQuota?: boolean;
}

/** Тело properties.runFunnelReport (Data API v1alpha). */
export function buildFunnelBody(args: FunnelBodyArgs): Record<string, unknown> {
  validateDateRange(args.startDate, args.endDate);
  if (args.steps.length < 2) {
    throw new Error(`Воронка требует минимум ДВА шага (передано: ${args.steps.length}) — иначе считать нечего.`);
  }
  const steps = args.steps.map((step, i) => {
    const parts: Record<string, unknown>[] = [];
    if (step.eventName) parts.push({ funnelEventFilter: { eventName: step.eventName } });
    for (const f of step.filters ?? []) parts.push(funnelFieldExpression(f));
    if (!parts.length) {
      throw new Error(`Шаг ${i + 1} ("${step.name}") пустой: задай eventName и/или filters — иначе шаг совпадёт с чем угодно.`);
    }
    const out: Record<string, unknown> = {
      name: step.name,
      filterExpression: parts.length === 1 ? parts[0] : { andGroup: { expressions: parts } },
    };
    // оба ограничения бессмысленны на первом шаге: до него ничего не было
    if (i > 0 && step.isDirectlyFollowedBy) out.isDirectlyFollowedBy = true;
    if (i > 0 && step.withinMinutesFromPriorStep) {
      out.withinDurationFromPriorStep = `${Math.round(step.withinMinutesFromPriorStep * 60)}s`;
    }
    return out;
  });
  const body: Record<string, unknown> = {
    dateRanges: [{ startDate: args.startDate, endDate: args.endDate }],
    // API-умолчание — ЗАКРЫТАЯ воронка (isOpenFunnel отсутствует ⇒ false)
    funnel: { isOpenFunnel: Boolean(args.openFunnel), steps },
    limit: args.limit,
  };
  if (args.breakdownDimension) {
    body.funnelBreakdown = {
      breakdownDimension: { name: args.breakdownDimension },
      ...(args.breakdownLimit ? { limit: args.breakdownLimit } : {}),
    };
  }
  const filter = buildDimensionFilter(args.filters);
  if (filter) body.dimensionFilter = filter;
  if (args.returnPropertyQuota) body.returnPropertyQuota = true;
  return body;
}

export interface QuotaBucket {
  consumed: number;
  remaining: number;
}

/**
 * propertyQuota ответа → плоские числа. Google отдаёт корзины объектами
 * { consumed, remaining }; пустые не выдумываем — их отсутствие само по себе значимо
 * (у стандартных свойств часть лимитов не применяется).
 */
export function parsePropertyQuota(data: any): Record<string, QuotaBucket> | undefined {
  const raw = data?.propertyQuota;
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, QuotaBucket> = {};
  for (const [key, value] of Object.entries<any>(raw)) {
    if (!value || typeof value !== 'object') continue;
    if (value.consumed == null && value.remaining == null) continue;
    out[key] = { consumed: Number(value.consumed ?? 0), remaining: Number(value.remaining ?? 0) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** google.type.Date ({year, month, day}) → YYYY-MM-DD. */
function typeDate(d: any): string | null {
  if (!d || d.year == null) return null;
  const pad = (n: unknown) => String(Number(n ?? 1)).padStart(2, '0');
  return `${Number(d.year)}-${pad(d.month)}-${pad(d.day)}`;
}

export interface Ga4Annotation {
  title: string;
  description?: string;
  /** дата или начало периода */
  date: string | null;
  /** конец периода (только у аннотаций-диапазонов) */
  endDate?: string | null;
  color?: string;
  /** true — аннотация создана самой GA4, а не пользователем */
  systemGenerated: boolean;
  id: string;
}

export interface ParsedAnnotations {
  count: number;
  annotations: Ga4Annotation[];
  truncated: boolean;
}

/** Ответ properties.reportingDataAnnotations.list → плоский список с датами в ISO. */
export function parseAnnotations(data: any, limit = 100): ParsedAnnotations {
  const raw: any[] = Array.isArray(data?.reportingDataAnnotations) ? data.reportingDataAnnotations : [];
  const annotations = raw.slice(0, limit).map((a) => {
    const range = a?.annotationDateRange;
    const out: Ga4Annotation = {
      title: String(a?.title ?? ''),
      // одиночная дата и диапазон — взаимоисключающие поля; сводим к одной паре date/endDate
      date: typeDate(a?.annotationDate) ?? typeDate(range?.startDate),
      systemGenerated: Boolean(a?.systemGenerated),
      id:
        String(a?.name ?? '')
          .split('/')
          .pop() ?? '',
    };
    if (a?.description) out.description = String(a.description);
    if (range?.endDate) out.endDate = typeDate(range.endDate);
    if (a?.color) out.color = String(a.color);
    return out;
  });
  return { count: annotations.length, annotations, truncated: raw.length > limit || Boolean(data?.nextPageToken) };
}

export interface Ga4DataStream {
  id: string;
  displayName: string;
  type: string;
  /** G-XXXXXXX — только у веб-потоков; именно его часто путают с propertyId */
  measurementId?: string;
  defaultUri?: string;
}

export interface ParsedPropertyDetails {
  propertyId: string;
  displayName: string;
  /** таймзона отчётов: даты GA4 считаются в ней, а не в UTC */
  timeZone: string | null;
  currency: string | null;
  industry: string | null;
  /** STANDARD или GOOGLE_ANALYTICS_360 — от него зависят квоты и сэмплирование */
  serviceLevel: string | null;
  createTime: string | null;
  parentAccount: string | null;
  dataStreams: Ga4DataStream[];
}

/** properties.get + dataStreams.list → одна плоская карточка свойства. */
export function parsePropertyDetails(property: any, streams: any): ParsedPropertyDetails {
  const raw: any[] = Array.isArray(streams?.dataStreams) ? streams.dataStreams : [];
  return {
    propertyId:
      String(property?.name ?? '')
        .split('/')
        .pop() ?? '',
    displayName: String(property?.displayName ?? ''),
    timeZone: property?.timeZone ? String(property.timeZone) : null,
    currency: property?.currencyCode ? String(property.currencyCode) : null,
    industry: property?.industryCategory ? String(property.industryCategory) : null,
    serviceLevel: property?.serviceLevel ? String(property.serviceLevel) : null,
    createTime: property?.createTime ? String(property.createTime) : null,
    parentAccount: property?.parent ? String(property.parent) : null,
    dataStreams: raw.map((s) => {
      const out: Ga4DataStream = {
        id:
          String(s?.name ?? '')
            .split('/')
            .pop() ?? '',
        displayName: String(s?.displayName ?? ''),
        type: String(s?.type ?? ''),
      };
      if (s?.webStreamData?.measurementId) out.measurementId = String(s.webStreamData.measurementId);
      if (s?.webStreamData?.defaultUri) out.defaultUri = String(s.webStreamData.defaultUri);
      return out;
    }),
  };
}

/** Метка агрегата в разбивке воронки (вместо служебного RESERVED_TOTAL). */
export const FUNNEL_BREAKDOWN_TOTAL = '(всего)';

/**
 * При funnelBreakdown GA4 добавляет к каждому шагу строку-итог, помечая её в колонке
 * разбивки служебным RESERVED_TOTAL. Оставить как есть нельзя: строка выглядит обычным
 * значением измерения, и сумма по строкам шага удваивается. Переименовываем в явную метку.
 */
export function markFunnelTotals(rows: Ga4ReportRow[], breakdownDimension?: string): { rows: Ga4ReportRow[]; hasTotals: boolean } {
  if (!breakdownDimension) return { rows, hasTotals: false };
  let hasTotals = false;
  const out = rows.map((row) => {
    const value = row[breakdownDimension];
    if (typeof value !== 'string' || !/^RESERVED_/.test(value)) return row;
    hasTotals = true;
    return { ...row, [breakdownDimension]: FUNNEL_BREAKDOWN_TOTAL };
  });
  return { rows: out, hasTotals };
}
