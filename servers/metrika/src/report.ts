/** Маппинг строк отчёта Stat API — вынесено из index.ts для тестируемости. */
import type { StatResponse } from './paginate.js';

/** ym:s:regionCountry → regionCountry (короткий ключ для вывода). */
export const shortKey = (name: string): string => name.replace(/^ym:[a-z]+:/i, '');

/** Зипует измерения и метрики строки в объект с короткими ключами. */
export function mapReportRows(res: StatResponse, dimensions: string[], metrics: string[]): Record<string, unknown>[] {
  return res.data.map((r) => {
    const out: Record<string, unknown> = {};
    dimensions.forEach((dim, i) => {
      out[shortKey(dim)] = r.dimensions[i]?.name ?? null;
    });
    metrics.forEach((m, i) => {
      out[shortKey(m)] = r.metrics[i] ?? null;
    });
    return out;
  });
}
