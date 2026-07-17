import { describe, expect, it } from 'vitest';
import type { StatResponse } from '../servers/metrika/src/paginate.js';
import { mapReportRows, shortKey } from '../servers/metrika/src/report.js';

describe('shortKey', () => {
  it('срезает префикс неймспейса Метрики', () => {
    expect(shortKey('ym:s:regionCity')).toBe('regionCity');
    expect(shortKey('ym:pv:URL')).toBe('URL');
    expect(shortKey('ym:s:goal123reaches')).toBe('goal123reaches');
  });
  it('имя без префикса не трогает', () => {
    expect(shortKey('visits')).toBe('visits');
  });
});

describe('mapReportRows', () => {
  const res: StatResponse = {
    data: [
      { dimensions: [{ name: 'Search engine traffic' }], metrics: [2872, 2681, 12.5] },
      { dimensions: [{ name: 'Direct traffic' }], metrics: [1333, 1200, 20] },
    ],
  };
  it('зипует измерения и метрики в короткие ключи', () => {
    const rows = mapReportRows(res, ['ym:s:lastTrafficSource'], ['ym:s:visits', 'ym:s:users', 'ym:s:bounceRate']);
    expect(rows[0]).toEqual({ lastTrafficSource: 'Search engine traffic', visits: 2872, users: 2681, bounceRate: 12.5 });
    expect(rows[1].lastTrafficSource).toBe('Direct traffic');
  });
  it('без измерений — только метрики', () => {
    expect(mapReportRows(res, [], ['ym:s:visits'])[0]).toEqual({ visits: 2872 });
  });
  it('нехватка измерения → null', () => {
    const r = mapReportRows({ data: [{ dimensions: [], metrics: [5] }] }, ['ym:s:x'], ['ym:s:visits']);
    expect(r[0]).toEqual({ x: null, visits: 5 });
  });
});
