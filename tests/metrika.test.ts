import { describe, expect, it } from 'vitest';
import { escFilter, landingFilter } from '../servers/metrika/src/filters.js';
import { collectAllPages, rowKey, type StatResponse } from '../servers/metrika/src/paginate.js';

const mkRow = (name: string) => ({ dimensions: [{ name }], metrics: [] });
const names = (r: StatResponse) => r.data.map((d) => d.dimensions[0].name);

/** Фейковый Stat API: total строк, страница может быть короче limit или перекрывать предыдущую. */
function fakeApi(total: number, mode: 'exact' | 'short' | 'overlap' | 'stuck' = 'exact') {
  const all = Array.from({ length: total }, (_, i) => mkRow(`r${i + 1}`));
  return async (offset: number, limit: number): Promise<StatResponse> => {
    if (mode === 'stuck') return { data: all.slice(0, Math.min(limit, total)), total_rows: total }; // всегда одно и то же
    const start = offset - 1; // 1-based
    const eff = mode === 'overlap' ? Math.max(0, start - 1) : start; // отдаёт на 1 строку раньше
    let slice = all.slice(eff, eff + limit);
    if (mode === 'short' && slice.length === limit) slice = slice.slice(0, limit - 1); // всегда на 1 короче
    return { data: slice, total_rows: total };
  };
}

describe('collectAllPages', () => {
  it('обычная пагинация собирает все строки', async () => {
    const res = await collectAllPages(fakeApi(23, 'exact'), 1000, 5);
    expect(res.data).toHaveLength(23);
    expect(names(res)).toEqual(Array.from({ length: 23 }, (_, i) => `r${i + 1}`));
  });

  it('короткие страницы (accuracy:full) не теряют строки', async () => {
    const res = await collectAllPages(fakeApi(23, 'short'), 1000, 5);
    expect(res.data).toHaveLength(23);
    expect(new Set(names(res)).size).toBe(23); // без пропусков и дублей
  });

  it('перекрывающиеся окна дедуплицируются', async () => {
    const res = await collectAllPages(fakeApi(20, 'overlap'), 1000, 5);
    expect(res.data).toHaveLength(20);
    expect(new Set(names(res)).size).toBe(20); // дублей нет
  });

  it('сервер отдаёт одно и то же → выход без зацикливания', async () => {
    const res = await collectAllPages(fakeApi(50, 'stuck'), 1000, 5);
    expect(res.data.length).toBeLessThanOrEqual(50);
    expect(new Set(names(res)).size).toBe(res.data.length); // без дублей
  });

  it('обрезает по maxRows', async () => {
    const res = await collectAllPages(fakeApi(100, 'exact'), 10, 5);
    expect(res.data).toHaveLength(10);
  });

  it('total_rows=0 → только первая страница', async () => {
    const api = async (): Promise<StatResponse> => ({ data: [], total_rows: 0 });
    const res = await collectAllPages(api, 1000, 5);
    expect(res.data).toHaveLength(0);
  });
});

describe('rowKey', () => {
  it('различает разные комбинации многомерных измерений (SOH-разделитель)', () => {
    const a = rowKey({ dimensions: [{ name: 'ab' }, { name: 'c' }], metrics: [] });
    const b = rowKey({ dimensions: [{ name: 'a' }, { name: 'bc' }], metrics: [] });
    expect(a).not.toBe(b); // при join('') они бы совпали
  });
});

describe('landingFilter / escFilter', () => {
  it('полный URL → startURL', () => {
    expect(landingFilter('https://example.com/oae/')).toBe("ym:s:startURL=='https://example.com/oae/'");
  });
  it('относительный путь → startURLPath', () => {
    expect(landingFilter('/oae/dubai/')).toBe("ym:s:startURLPath=='/oae/dubai/'");
  });
  it('экранирует апостроф', () => {
    expect(escFilter("o'ae")).toBe("o\\'ae");
    expect(landingFilter("/o'ae/")).toBe("ym:s:startURLPath=='/o\\'ae/'");
  });
});
