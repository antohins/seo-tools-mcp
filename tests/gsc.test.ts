import { describe, it, expect } from 'vitest';
import { collectRows } from '../servers/gsc/src/paginate.js';

/** Фейковый источник страниц: total строк, отдаёт [startRow .. startRow+rowLimit-1]. */
function fakeSource(total: number) {
  return async (rowLimit: number, startRow: number): Promise<number[]> => {
    const out: number[] = [];
    for (let i = 0; i < rowLimit && startRow + i < total; i++) out.push(startRow + i);
    return out;
  };
}

describe('collectRows (gsc пагинация + truncated)', () => {
  it('данных больше лимита → truncated=true, ровно limit строк', async () => {
    const r = await collectRows(fakeSource(100_000), 5000, 25_000);
    expect(r.rows).toHaveLength(5000);
    expect(r.truncated).toBe(true);
  });

  it('данных меньше лимита → truncated=false', async () => {
    const r = await collectRows(fakeSource(3000), 5000, 25_000);
    expect(r.rows).toHaveLength(3000);
    expect(r.truncated).toBe(false);
  });

  it('данных РОВНО limit → truncated=false (не ложное true)', async () => {
    const r = await collectRows(fakeSource(5000), 5000, 25_000);
    expect(r.rows).toHaveLength(5000);
    expect(r.truncated).toBe(false);
  });

  it('граница на кратном pageSize: ровно 25000 → false', async () => {
    const r = await collectRows(fakeSource(25_000), 25_000, 25_000);
    expect(r.rows).toHaveLength(25_000);
    expect(r.truncated).toBe(false);
  });

  it('на 1 строку больше лимита → true', async () => {
    const r = await collectRows(fakeSource(25_001), 25_000, 25_000);
    expect(r.rows).toHaveLength(25_000);
    expect(r.truncated).toBe(true);
  });

  it('многостраничная сборка склеивает страницы по порядку', async () => {
    const r = await collectRows(fakeSource(12), 12, 5);
    expect(r.rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(r.truncated).toBe(false);
  });
});
