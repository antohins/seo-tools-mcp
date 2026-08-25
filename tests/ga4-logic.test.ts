import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ENV_FILE и снапшот process.env вычисляются при импорте shared/config.js —
// поэтому env выставляется ДО динамического импорта модуля (образец — tests/gsc-logic.test.ts).
let logic: typeof import('../servers/ga4/src/logic.js');
let sharedDist: typeof import('../shared/src/index.js');
let dir: string;
let envFile: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'seo-tools-ga4-'));
  envFile = join(dir, '.env');
  process.env.SEO_TOOLS_MCP_ENV = envFile;
  writeFileSync(envFile, '', { mode: 0o600 });
  sharedDist = await import('../servers/ga4/node_modules/@seo-tools/shared');
  logic = await import('../servers/ga4/src/logic.js');
});

afterAll(() => {
  delete process.env.SEO_TOOLS_MCP_ENV;
  rmSync(dir, { recursive: true, force: true });
});

/** Перезаписывает временный env-файл и сбрасывает mtime-кеш shared. */
function setEnvFile(text: string): void {
  writeFileSync(envFile, text, { mode: 0o600 });
  sharedDist.readConfigFile(true);
}

describe('resolveProperty', () => {
  it('числовой id и properties/<id> дают один и тот же ресурс', () => {
    expect(logic.resolveProperty('123456789')).toBe('properties/123456789');
    expect(logic.resolveProperty('properties/123456789')).toBe('properties/123456789');
    expect(logic.resolveProperty('  123456789  ')).toBe('properties/123456789');
  });

  it('дефолт берётся из GA4_PROPERTY_ID, в т.ч. по профилю', () => {
    setEnvFile('GA4_PROPERTY_ID=111\nGA4_PROPERTY_ID__clientX=222\n');
    expect(logic.resolveProperty()).toBe('properties/111');
    expect(logic.resolveProperty(undefined, 'clientX')).toBe('properties/222');
    setEnvFile('');
  });

  it('без свойства → ошибка с адресацией на ga4_list_properties', () => {
    setEnvFile('');
    expect(() => logic.resolveProperty()).toThrow(/ga4_list_properties/);
    expect(() => logic.resolveProperty(undefined, 'clientX')).toThrow(/для аккаунта «clientX»/);
  });

  it('Measurement ID (G-XXXX) и мусор отклоняются с понятной ошибкой', () => {
    expect(() => logic.resolveProperty('G-ABC123')).toThrow(/НЕ Measurement ID/);
    expect(() => logic.resolveProperty('properties/G-ABC')).toThrow(/числовой id/);
  });
});

describe('validateDateRange', () => {
  it('YYYY-MM-DD и ключевые слова GA4 проходят', () => {
    expect(() => logic.validateDateRange('2026-01-01', '2026-01-31')).not.toThrow();
    expect(() => logic.validateDateRange('28daysAgo', 'yesterday')).not.toThrow();
    expect(() => logic.validateDateRange('today', 'today')).not.toThrow();
  });

  it('мусорная дата → понятная ошибка', () => {
    expect(() => logic.validateDateRange('01.01.2026', 'yesterday')).toThrow(/startDate/);
    expect(() => logic.validateDateRange('2026-01-01', 'last week')).toThrow(/endDate/);
  });

  it('start > end (обе абсолютные) → ошибка; с ключевыми словами не сравниваем', () => {
    expect(() => logic.validateDateRange('2026-02-01', '2026-01-01')).toThrow(/позже/);
    // «28daysAgo» резолвит GA4 в таймзоне свойства — локальное сравнение некорректно
    expect(() => logic.validateDateRange('28daysAgo', '2020-01-01')).not.toThrow();
  });
});

describe('buildDimensionFilter', () => {
  it('пусто → undefined (поле не уходит в тело)', () => {
    expect(logic.buildDimensionFilter()).toBeUndefined();
    expect(logic.buildDimensionFilter([])).toBeUndefined();
  });

  it('один фильтр — без andGroup', () => {
    expect(logic.buildDimensionFilter([{ dimension: 'pagePath', matchType: 'CONTAINS', value: '/blog' }])).toEqual({
      filter: { fieldName: 'pagePath', stringFilter: { matchType: 'CONTAINS', value: '/blog', caseSensitive: false } },
    });
  });

  it('несколько фильтров объединяются AND; not → notExpression', () => {
    const f = logic.buildDimensionFilter([
      { dimension: 'sessionDefaultChannelGroup', matchType: 'EXACT', value: 'Organic Search' },
      { dimension: 'pagePath', matchType: 'CONTAINS', value: '/admin', not: true },
    ]) as any;
    expect(f.andGroup.expressions).toHaveLength(2);
    expect(f.andGroup.expressions[1].notExpression.filter.fieldName).toBe('pagePath');
  });
});

describe('buildReportBody', () => {
  const base = { startDate: '28daysAgo', endDate: 'yesterday', dimensions: ['date'], metrics: ['sessions'], limit: 100 };

  it('собирает dateRanges/dimensions/metrics/limit', () => {
    const b = logic.buildReportBody(base) as any;
    expect(b.dateRanges).toEqual([{ startDate: '28daysAgo', endDate: 'yesterday' }]);
    expect(b.dimensions).toEqual([{ name: 'date' }]);
    expect(b.metrics).toEqual([{ name: 'sessions' }]);
    expect(b.limit).toBe(100);
    // необязательные поля не добавляются
    expect(b.offset).toBeUndefined();
    expect(b.keepEmptyRows).toBeUndefined();
    expect(b.dimensionFilter).toBeUndefined();
    expect(b.orderBys).toBeUndefined();
  });

  it('orderBy по метрике → metric, по измерению → dimension', () => {
    expect((logic.buildReportBody({ ...base, orderBy: 'sessions' }) as any).orderBys[0]).toEqual({
      metric: { metricName: 'sessions' },
      desc: true,
    });
    expect((logic.buildReportBody({ ...base, orderBy: 'date', orderDesc: false }) as any).orderBys[0]).toEqual({
      dimension: { dimensionName: 'date' },
      desc: false,
    });
  });

  it('orderBy не из запроса → понятная локальная ошибка, а не 400 «not a valid dimension»', () => {
    // раньше метрика, забытая в metrics, уходила как dimension и API отвечал невнятной ошибкой
    expect(() => logic.buildReportBody({ ...base, orderBy: 'activeUsers' })).toThrow(/не входит ни в metrics/);
    expect(() => logic.buildReportBody({ ...base, orderBy: 'activeUsers' })).toThrow(/sessions/);
  });

  it('без метрик → ошибка до запроса', () => {
    expect(() => logic.buildReportBody({ ...base, metrics: [] })).toThrow(/метрики/);
  });

  it('невалидные даты ловятся до запроса', () => {
    expect(() => logic.buildReportBody({ ...base, startDate: '2026/01/01' })).toThrow(/startDate/);
  });

  it('сравнение периодов → два именованных dateRange', () => {
    const b = logic.buildReportBody({ ...base, compareStartDate: '56daysAgo', compareEndDate: '29daysAgo' }) as any;
    expect(b.dateRanges).toEqual([
      { startDate: '28daysAgo', endDate: 'yesterday', name: 'current' },
      { startDate: '56daysAgo', endDate: '29daysAgo', name: 'previous' },
    ]);
  });

  it('половина периода сравнения → ошибка до запроса', () => {
    expect(() => logic.buildReportBody({ ...base, compareStartDate: '56daysAgo' })).toThrow(/ОБА параметра/);
    expect(() => logic.buildReportBody({ ...base, compareEndDate: '29daysAgo' })).toThrow(/ОБА параметра/);
  });

  it('даты периода сравнения тоже валидируются', () => {
    expect(() => logic.buildReportBody({ ...base, compareStartDate: '01.01.2026', compareEndDate: 'yesterday' })).toThrow(/startDate/);
  });

  it('includeTotals → metricAggregations, иначе поля нет', () => {
    expect((logic.buildReportBody({ ...base, includeTotals: true }) as any).metricAggregations).toEqual(['TOTAL']);
    expect((logic.buildReportBody(base) as any).metricAggregations).toBeUndefined();
  });
});

describe('buildMetricFilter', () => {
  it('пусто → undefined', () => {
    expect(logic.buildMetricFilter()).toBeUndefined();
    expect(logic.buildMetricFilter([])).toBeUndefined();
  });

  it('целое → int64Value строкой, дробное → doubleValue', () => {
    expect(logic.buildMetricFilter([{ metric: 'sessions', operation: 'GREATER_THAN', value: 50 }])).toEqual({
      filter: { fieldName: 'sessions', numericFilter: { operation: 'GREATER_THAN', value: { int64Value: '50' } } },
    });
    const f = logic.buildMetricFilter([{ metric: 'engagementRate', operation: 'LESS_THAN', value: 0.5 }]) as any;
    expect(f.filter.numericFilter.value).toEqual({ doubleValue: 0.5 });
  });

  it('несколько условий объединяются AND', () => {
    const f = logic.buildMetricFilter([
      { metric: 'sessions', operation: 'GREATER_THAN', value: 10 },
      { metric: 'bounceRate', operation: 'LESS_THAN', value: 0.7 },
    ]) as any;
    expect(f.andGroup.expressions).toHaveLength(2);
  });

  it('попадает в тело отчёта как metricFilter', () => {
    const b = logic.buildReportBody({
      startDate: '28daysAgo',
      endDate: 'yesterday',
      dimensions: ['pagePath'],
      metrics: ['sessions'],
      limit: 10,
      metricFilters: [{ metric: 'sessions', operation: 'GREATER_THAN_OR_EQUAL', value: 100 }],
    }) as any;
    expect(b.metricFilter.filter.fieldName).toBe('sessions');
  });
});

describe('parseReport', () => {
  const sample = {
    dimensionHeaders: [{ name: 'date' }],
    metricHeaders: [{ name: 'sessions' }, { name: 'bounceRate' }],
    rows: [
      { dimensionValues: [{ value: '20260801' }], metricValues: [{ value: '150' }, { value: '0.4523' }] },
      { dimensionValues: [{ value: '20260802' }], metricValues: [{ value: '99' }, { value: '0.5' }] },
    ],
    rowCount: 2,
    metadata: { currencyCode: 'USD', timeZone: 'Europe/Moscow' },
  };

  it('строки → плоские объекты, метрики приводятся к числам', () => {
    const r = logic.parseReport(sample);
    expect(r.count).toBe(2);
    expect(r.rows[0]).toEqual({ date: '20260801', sessions: 150, bounceRate: 0.4523 });
    expect(r.totalRows).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.timeZone).toBe('Europe/Moscow');
    expect(r.currency).toBe('USD');
    expect(r.thresholded).toBe(false);
  });

  it('rowCount больше отданных строк → truncated', () => {
    const r = logic.parseReport({ ...sample, rowCount: 500 });
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBe(500);
  });

  it('последняя страница при offset → truncated=false (не зацикливаем пагинацию)', () => {
    // всего 450 строк, взяли последние 50 со смещением 400: обрезки НЕТ
    const r = logic.parseReport({ ...sample, rowCount: 450 }, { offset: 448 });
    expect(r.count).toBe(2);
    expect(r.truncated).toBe(false);
    // а вот в середине выборки обрезка есть
    expect(logic.parseReport({ ...sample, rowCount: 450 }, { offset: 100 }).truncated).toBe(true);
  });

  it('realtime (withMetadata:false) → полей метаданных нет вовсе, а не null-пустышки', () => {
    const r = logic.parseReport({ ...sample, metadata: undefined }, { withMetadata: false });
    expect(r.count).toBe(2);
    expect('timeZone' in r).toBe(false);
    expect('currency' in r).toBe(false);
    expect('thresholded' in r).toBe(false);
  });

  it('порог конфиденциальности отражается флагом', () => {
    expect(logic.parseReport({ ...sample, metadata: { subjectToThresholding: true } }).thresholded).toBe(true);
  });

  it('пустой/битый ответ → безопасные значения без падения', () => {
    expect(logic.parseReport({})).toEqual({
      rows: [],
      count: 0,
      totalRows: null,
      truncated: false,
      timeZone: null,
      currency: null,
      thresholded: false,
    });
    expect(logic.parseReport(null).rows).toEqual([]);
  });
});

describe('flattenAccountSummaries', () => {
  it('разворачивает аккаунты в плоский список свойств', () => {
    const list = logic.flattenAccountSummaries({
      accountSummaries: [
        {
          account: 'accounts/1',
          displayName: 'Агентство',
          propertySummaries: [
            { property: 'properties/111', displayName: 'Сайт А' },
            { property: 'properties/222', displayName: 'Сайт Б' },
          ],
        },
      ],
    });
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      property: 'properties/111',
      propertyId: '111',
      displayName: 'Сайт А',
      account: 'accounts/1',
      accountName: 'Агентство',
    });
  });

  it('аккаунты без свойств и битый ответ не ломают разбор', () => {
    expect(logic.flattenAccountSummaries({ accountSummaries: [{ account: 'accounts/1' }] })).toEqual([]);
    expect(logic.flattenAccountSummaries(null)).toEqual([]);
  });
});
describe('parseMetadata', () => {
  const meta = {
    dimensions: [
      { apiName: 'landingPage', uiName: 'Landing page', category: 'Page / Screen', description: 'Page path of first pageview' },
      { apiName: 'pagePath', uiName: 'Page path', category: 'Page / Screen' },
      { apiName: 'customEvent:level', uiName: 'Level', category: 'Custom', customDefinition: true },
    ],
    metrics: [
      { apiName: 'sessions', uiName: 'Sessions', category: 'Session', type: 'TYPE_INTEGER' },
      {
        apiName: 'totalRevenue',
        uiName: 'Total revenue',
        category: 'Revenue',
        type: 'TYPE_CURRENCY',
        blockedReasons: ['NO_REVENUE_METRICS'],
      },
    ],
  };

  it('счётчики раздельные: сколько подошло под фильтр и сколько всего в свойстве', () => {
    const r = logic.parseMetadata(meta, { search: 'landing' });
    expect(r.matchedDimensions).toBe(1);
    expect(r.dimensionsInProperty).toBe(3); // всего у свойства, а не «сколько нашли»
    expect(r.matchedMetrics).toBe(0);
    expect(r.metricsInProperty).toBe(2);
  });

  it('type и blockedReasons сохраняются (нули без ошибки / 400 в metricFilters)', () => {
    const m = logic.parseMetadata(meta).metrics.find((x) => x.apiName === 'totalRevenue');
    expect(m?.type).toBe('TYPE_CURRENCY');
    expect(m?.blockedReasons).toEqual(['NO_REVENUE_METRICS']);
    // у незаблокированной метрики поля нет
    expect(logic.parseMetadata(meta).metrics.find((x) => x.apiName === 'sessions')?.blockedReasons).toBeUndefined();
  });

  it('описания по умолчанию не отдаются, но поиск по ним работает', () => {
    expect(logic.parseMetadata(meta).dimensions[0].description).toBeUndefined();
    expect(logic.parseMetadata(meta, { withDescriptions: true }).dimensions[0].description).toContain('first pageview');
    // ищем по тексту, которого нет ни в apiName, ни в uiName
    expect(logic.parseMetadata(meta, { search: 'first pageview' }).dimensions.map((d) => d.apiName)).toEqual(['landingPage']);
  });

  it('customOnly оставляет только кастомные', () => {
    const r = logic.parseMetadata(meta, { customOnly: true });
    expect(r.dimensions.map((d) => d.apiName)).toEqual(['customEvent:level']);
    expect(r.matchedMetrics).toBe(0);
  });

  it('truncated раздельный по спискам', () => {
    const r = logic.parseMetadata(meta, { limit: 1 });
    expect(r.dimensionsTruncated).toBe(true); // 3 подошло, показали 1
    expect(r.metricsTruncated).toBe(true); // 2 подошло, показали 1
    expect(logic.parseMetadata(meta, { limit: 50 }).dimensionsTruncated).toBe(false);
  });

  it('битый ответ не роняет разбор', () => {
    expect(logic.parseMetadata(null).dimensionsInProperty).toBe(0);
    expect(logic.parseMetadata({}).metrics).toEqual([]);
  });
});

describe('parseCompatibility', () => {
  // Контракт метода: ответ перечисляет поля, которые МОЖНО ДОБАВИТЬ к запросу,
  // а не статус запрошенных полей. Несовместимость самой связки = ошибка вызова.
  const sample = {
    dimensionCompatibilities: [
      { dimensionMetadata: { apiName: 'date' }, compatibility: 'COMPATIBLE' },
      { dimensionMetadata: { apiName: 'city' }, compatibility: 'COMPATIBLE' },
      { dimensionMetadata: { apiName: 'campaignId' }, compatibility: 'INCOMPATIBLE' },
    ],
    metricCompatibilities: [
      { metricMetadata: { apiName: 'sessions' }, compatibility: 'COMPATIBLE' },
      { metricMetadata: { apiName: 'organicGoogleSearchClicks' }, compatibility: 'INCOMPATIBLE' },
    ],
  };

  it('берёт ТОЛЬКО COMPATIBLE — это поля, которые можно добавить', () => {
    const r = logic.parseCompatibility(sample);
    expect(r.canAddDimensions).toEqual(['date', 'city']);
    expect(r.canAddMetrics).toEqual(['sessions']);
    expect(r.canAddDimensionsTotal).toBe(2);
    expect(r.canAddMetricsTotal).toBe(1);
    expect(r.truncated).toBe(false);
  });

  it('длинный список обрезается лимитом (у свойства таких полей сотни)', () => {
    const r = logic.parseCompatibility(sample, 1);
    expect(r.canAddDimensions).toEqual(['date']);
    expect(r.canAddDimensionsTotal).toBe(2);
    expect(r.truncated).toBe(true);
  });

  it('пустой ответ → пустые списки', () => {
    expect(logic.parseCompatibility(null).canAddDimensions).toEqual([]);
  });
});

describe('incompatibleFieldsFromError', () => {
  it('достаёт поля из живого текста ошибки GA4', () => {
    const msg =
      "Please remove organicGoogleSearchAveragePosition and organicGoogleSearchClicks and organicGoogleSearchImpressions to make the request compatible for example. The request's dimensions & metrics are incompatible.";
    expect(logic.incompatibleFieldsFromError(msg)).toEqual([
      'organicGoogleSearchAveragePosition',
      'organicGoogleSearchClicks',
      'organicGoogleSearchImpressions',
    ]);
  });

  it('чужой текст → пустой список', () => {
    expect(logic.incompatibleFieldsFromError('some other error')).toEqual([]);
  });
});

describe('parseReport: итоги', () => {
  it('в totals служебные RESERVED_* отбрасываются, а метка периода сохраняется', () => {
    const r = logic.parseReport({
      dimensionHeaders: [{ name: 'pagePath' }, { name: 'dateRange' }],
      metricHeaders: [{ name: 'sessions' }],
      rows: [{ dimensionValues: [{ value: '/' }, { value: 'current' }], metricValues: [{ value: '10' }] }],
      totals: [
        { dimensionValues: [{ value: 'RESERVED_TOTAL' }, { value: 'current' }], metricValues: [{ value: '999' }] },
        { dimensionValues: [{ value: 'RESERVED_TOTAL' }, { value: 'previous' }], metricValues: [{ value: '888' }] },
      ],
      rowCount: 1,
    });
    // без метки периода нельзя понять, какой итог к какому периоду относится
    expect(r.totals).toEqual([
      { dateRange: 'current', sessions: 999 },
      { dateRange: 'previous', sessions: 888 },
    ]);
    expect(JSON.stringify(r.totals)).not.toContain('RESERVED_TOTAL');
  });

  it('строки при сравнении содержат колонку dateRange', () => {
    const r = logic.parseReport({
      dimensionHeaders: [{ name: 'dateRange' }],
      metricHeaders: [{ name: 'sessions' }],
      rows: [
        { dimensionValues: [{ value: 'current' }], metricValues: [{ value: '5' }] },
        { dimensionValues: [{ value: 'previous' }], metricValues: [{ value: '3' }] },
      ],
      rowCount: 2,
    });
    expect(r.rows).toEqual([
      { dateRange: 'current', sessions: 5 },
      { dateRange: 'previous', sessions: 3 },
    ]);
  });

  it('без totals поле отсутствует', () => {
    expect('totals' in logic.parseReport({ rowCount: 0 })).toBe(false);
  });
});

describe('buildFunnelBody', () => {
  const base = { startDate: '2026-01-01', endDate: '2026-01-31', limit: 100 };

  it('шаг по событию + условие по измерению объединяются через AND', () => {
    const body = logic.buildFunnelBody({
      ...base,
      steps: [
        { name: 'Просмотр', eventName: 'page_view', filters: [{ dimension: 'pagePath', matchType: 'BEGINS_WITH', value: '/catalog' }] },
        { name: 'Покупка', eventName: 'purchase' },
      ],
    });
    const funnel = body.funnel as any;
    expect(funnel.steps[0].filterExpression.andGroup.expressions).toEqual([
      { funnelEventFilter: { eventName: 'page_view' } },
      { funnelFieldFilter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/catalog', caseSensitive: false } } },
    ]);
    // одиночное условие не заворачивается в группу
    expect(funnel.steps[1].filterExpression).toEqual({ funnelEventFilter: { eventName: 'purchase' } });
  });

  it('по умолчанию воронка ЗАКРЫТАЯ', () => {
    // API-умолчание тоже false, но полагаться на него нельзя: смысл воронки меняется целиком
    expect(
      (
        logic.buildFunnelBody({
          ...base,
          steps: [
            { name: 'a', eventName: 'x' },
            { name: 'b', eventName: 'y' },
          ],
        }).funnel as any
      ).isOpenFunnel,
    ).toBe(false);
    const open = logic.buildFunnelBody({
      ...base,
      openFunnel: true,
      steps: [
        { name: 'a', eventName: 'x' },
        { name: 'b', eventName: 'y' },
      ],
    });
    expect((open.funnel as any).isOpenFunnel).toBe(true);
  });

  it('ограничения «сразу после» и «не позже N минут» на первом шаге отбрасываются', () => {
    // до первого шага ничего не было — GA4 такие поля молча игнорирует, но в теле они мусор
    const body = logic.buildFunnelBody({
      ...base,
      steps: [
        { name: 'a', eventName: 'x', isDirectlyFollowedBy: true, withinMinutesFromPriorStep: 5 },
        { name: 'b', eventName: 'y', isDirectlyFollowedBy: true, withinMinutesFromPriorStep: 30 },
      ],
    });
    const steps = (body.funnel as any).steps;
    expect(steps[0].isDirectlyFollowedBy).toBeUndefined();
    expect(steps[0].withinDurationFromPriorStep).toBeUndefined();
    expect(steps[1]).toMatchObject({ isDirectlyFollowedBy: true, withinDurationFromPriorStep: '1800s' });
  });

  it('меньше двух шагов и пустой шаг — ошибка с объяснением', () => {
    expect(() => logic.buildFunnelBody({ ...base, steps: [{ name: 'a', eventName: 'x' }] })).toThrow(/минимум ДВА шага/);
    expect(() => logic.buildFunnelBody({ ...base, steps: [{ name: 'a', eventName: 'x' }, { name: 'b' }] })).toThrow(/Шаг 2 \("b"\) пустой/);
  });

  it('разбивка и общий фильтр попадают в тело', () => {
    const body = logic.buildFunnelBody({
      ...base,
      steps: [
        { name: 'a', eventName: 'x' },
        { name: 'b', eventName: 'y' },
      ],
      breakdownDimension: 'deviceCategory',
      breakdownLimit: 5,
      filters: [{ dimension: 'country', matchType: 'EXACT', value: 'Russia' }],
      returnPropertyQuota: true,
    });
    expect(body.funnelBreakdown).toEqual({ breakdownDimension: { name: 'deviceCategory' }, limit: 5 });
    expect(body.dimensionFilter).toBeDefined();
    expect(body.returnPropertyQuota).toBe(true);
  });
});

describe('parsePropertyQuota', () => {
  it('плоские корзины; пустые не выдумываются', () => {
    const quota = logic.parsePropertyQuota({
      propertyQuota: {
        tokensPerDay: { consumed: 12, remaining: 24988 },
        tokensPerHour: { consumed: 12, remaining: 4988 },
        concurrentRequests: {},
      },
    });
    expect(quota).toEqual({
      tokensPerDay: { consumed: 12, remaining: 24988 },
      tokensPerHour: { consumed: 12, remaining: 4988 },
    });
  });

  it('без propertyQuota — undefined, а не пустой объект', () => {
    // иначе в ответе появилось бы поле quota:{}, читаемое как «квота исчерпана»
    expect(logic.parsePropertyQuota({})).toBeUndefined();
    expect(logic.parsePropertyQuota({ propertyQuota: {} })).toBeUndefined();
  });
});

describe('parseAnnotations', () => {
  it('одиночная дата и период сводятся к date/endDate', () => {
    const parsed = logic.parseAnnotations({
      reportingDataAnnotations: [
        { name: 'properties/1/reportingDataAnnotations/77', title: 'Редизайн', annotationDate: { year: 2026, month: 3, day: 7 } },
        {
          name: 'properties/1/reportingDataAnnotations/78',
          title: 'Кампания',
          description: 'Чёрная пятница',
          annotationDateRange: { startDate: { year: 2025, month: 11, day: 24 }, endDate: { year: 2025, month: 12, day: 1 } },
          systemGenerated: true,
        },
      ],
    });
    expect(parsed.annotations[0]).toEqual({ id: '77', title: 'Редизайн', date: '2026-03-07', systemGenerated: false });
    expect(parsed.annotations[1]).toMatchObject({
      date: '2025-11-24',
      endDate: '2025-12-01',
      systemGenerated: true,
      description: 'Чёрная пятница',
    });
  });

  it('месяц и день дополняются нулём', () => {
    const parsed = logic.parseAnnotations({ reportingDataAnnotations: [{ title: 'x', annotationDate: { year: 2026, month: 1, day: 5 } }] });
    expect(parsed.annotations[0].date).toBe('2026-01-05');
  });

  it('nextPageToken означает truncated', () => {
    expect(logic.parseAnnotations({ reportingDataAnnotations: [], nextPageToken: 'abc' }).truncated).toBe(true);
    expect(logic.parseAnnotations({ reportingDataAnnotations: [{ title: 'a' }, { title: 'b' }] }, 1).truncated).toBe(true);
  });
});

describe('parsePropertyDetails', () => {
  it('карточка свойства + Measurement ID потоков', () => {
    const parsed = logic.parsePropertyDetails(
      {
        name: 'properties/479608460',
        displayName: 'auto.ae',
        timeZone: 'Asia/Dubai',
        currencyCode: 'AED',
        industryCategory: 'AUTOMOTIVE',
        serviceLevel: 'GOOGLE_ANALYTICS_STANDARD',
        createTime: '2024-02-01T10:00:00Z',
        parent: 'accounts/123',
      },
      {
        dataStreams: [
          {
            name: 'properties/479608460/dataStreams/9',
            displayName: 'Web',
            type: 'WEB_DATA_STREAM',
            webStreamData: { measurementId: 'G-ABC123', defaultUri: 'https://auto.ae' },
          },
        ],
      },
    );
    expect(parsed).toMatchObject({ propertyId: '479608460', timeZone: 'Asia/Dubai', serviceLevel: 'GOOGLE_ANALYTICS_STANDARD' });
    expect(parsed.dataStreams[0]).toEqual({
      id: '9',
      displayName: 'Web',
      type: 'WEB_DATA_STREAM',
      measurementId: 'G-ABC123',
      defaultUri: 'https://auto.ae',
    });
  });

  it('без потоков карточка всё равно собирается', () => {
    // dataStreams запрашиваются отдельно и могут упасть по правам — свойство важнее
    expect(logic.parsePropertyDetails({ name: 'properties/1', displayName: 'x' }, {}).dataStreams).toEqual([]);
  });
});

describe('markFunnelTotals', () => {
  const rows = [
    { funnelStepName: '1. Сессия', deviceCategory: 'RESERVED_TOTAL', activeUsers: 32810 },
    { funnelStepName: '1. Сессия', deviceCategory: 'mobile', activeUsers: 26283 },
    { funnelStepName: '1. Сессия', deviceCategory: 'desktop', activeUsers: 6197 },
  ];

  it('служебный RESERVED_TOTAL превращается в явную метку итога', () => {
    // без этого строка выглядит обычным значением разбивки и сумма по шагу удваивается
    const out = logic.markFunnelTotals(rows, 'deviceCategory');
    expect(out.hasTotals).toBe(true);
    expect(out.rows.map((r) => r.deviceCategory)).toEqual([logic.FUNNEL_BREAKDOWN_TOTAL, 'mobile', 'desktop']);
    expect(out.rows[0].activeUsers).toBe(32810);
  });

  it('без разбивки строки не трогаются', () => {
    const out = logic.markFunnelTotals(rows, undefined);
    expect(out.hasTotals).toBe(false);
    expect(out.rows).toBe(rows);
  });

  it('обычные значения не переименовываются', () => {
    const out = logic.markFunnelTotals([{ funnelStepName: '1', deviceCategory: 'mobile', activeUsers: 1 }], 'deviceCategory');
    expect(out.hasTotals).toBe(false);
    expect(out.rows[0].deviceCategory).toBe('mobile');
  });
});
