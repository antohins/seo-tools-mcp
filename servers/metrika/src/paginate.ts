/** Постраничный сбор данных Stat API Метрики — вынесено из index.ts для тестируемости. */

export interface StatResponse {
  data: Array<{ dimensions: Array<{ name: string }>; metrics: number[] }>;
  totals?: number[];
  total_rows?: number;
  sampled?: boolean;
  sample_share?: number;
}

/** Уникальный ключ строки — по именам всех измерений (SOH-разделитель не встречается в значениях). */
export function rowKey(r: StatResponse['data'][number]): string {
  return r.dimensions.map((d) => d.name).join(String.fromCharCode(1));
}

/**
 * Собирает все строки постранично (limit API — 100 000, шагами по 10 000).
 * Офсет двигаем по фактически ПРОЧИТАННЫМ строкам, а не на фикс. pageSize:
 * при accuracy:'full'/на хвосте страница короче limit, и фикс. шаг перепрыгнул бы
 * непрочитанные строки. Дедуп по ключу измерений страхует от перекрытия окон,
 * break при отсутствии новых строк — от зацикливания.
 * fetchPage(offset, limit) — инъекция реального statQuery (или фейка в тестах).
 */
export async function collectAllPages(
  fetchPage: (offset: number, limit: number) => Promise<StatResponse>,
  maxRows: number,
  pageSizeCap = 10_000, // размер страницы API; параметр — для тестов (в проде дефолт)
): Promise<StatResponse> {
  const pageSize = Math.min(pageSizeCap, maxRows);
  const first = await fetchPage(1, pageSize); // offset в Метрике 1-based
  const all: StatResponse = { ...first, data: [...first.data] };
  const seen = new Set(first.data.map(rowKey));
  let rawFetched = first.data.length;
  const wanted = Math.min(maxRows, first.total_rows ?? 0);
  while (all.data.length < wanted) {
    const page = await fetchPage(rawFetched + 1, pageSize);
    if (!page.data.length) break;
    rawFetched += page.data.length;
    let added = 0;
    for (const r of page.data) {
      const k = rowKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      all.data.push(r);
      added++;
    }
    if (!added) break; // страница не принесла новых строк — двигаться дальше некуда
  }
  all.data = all.data.slice(0, maxRows);
  return all;
}
