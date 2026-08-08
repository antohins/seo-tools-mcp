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

  it('без метрик → ошибка до запроса', () => {
    expect(() => logic.buildReportBody({ ...base, metrics: [] })).toThrow(/метрики/);
  });

  it('невалидные даты ловятся до запроса', () => {
    expect(() => logic.buildReportBody({ ...base, startDate: '2026/01/01' })).toThrow(/startDate/);
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
    const r = logic.parseReport(sample, 100);
    expect(r.count).toBe(2);
    expect(r.rows[0]).toEqual({ date: '20260801', sessions: 150, bounceRate: 0.4523 });
    expect(r.totalRows).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.timeZone).toBe('Europe/Moscow');
    expect(r.currency).toBe('USD');
    expect(r.thresholded).toBe(false);
  });

  it('rowCount больше отданных строк → truncated', () => {
    const r = logic.parseReport({ ...sample, rowCount: 500 }, 2);
    expect(r.truncated).toBe(true);
    expect(r.totalRows).toBe(500);
  });

  it('порог конфиденциальности отражается флагом', () => {
    expect(logic.parseReport({ ...sample, metadata: { subjectToThresholding: true } }, 100).thresholded).toBe(true);
  });

  it('пустой/битый ответ → безопасные значения без падения', () => {
    expect(logic.parseReport({}, 100)).toEqual({
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
