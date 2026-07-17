/** Постраничный сбор строк GSC Search Analytics — вынесено из index.ts для тестируемости. */

/**
 * Собирает строки постранично до limit. Тянет на 1 строку больше запрошенного (probe),
 * чтобы точно отличить «ровно limit» (данные кончились) от «есть ещё» — без ложного truncated.
 * fetchPage(rowLimit, startRow) — инъекция реального gscFetch (или фейка в тестах).
 */
export async function collectRows<T>(
  fetchPage: (rowLimit: number, startRow: number) => Promise<T[]>,
  limit: number,
  pageSize: number,
  deadlineMs?: number, // общий дедлайн на всю пагинацию (мс); превышен → отдаём собранное как truncated
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let startRow = 0;
  const probe = limit + 1;
  const startedAt = Date.now();
  while (rows.length < probe) {
    if (deadlineMs !== undefined && Date.now() - startedAt > deadlineMs) {
      return { rows: rows.slice(0, limit), truncated: true }; // страховка от компаундинга таймаутов на медленном API
    }
    const rowLimit = Math.min(pageSize, probe - rows.length);
    const batch = await fetchPage(rowLimit, startRow);
    rows.push(...batch);
    if (batch.length < rowLimit) break; // неполная страница — данных больше нет
    startRow += batch.length;
  }
  // получили лишнюю (limit+1)-ю строку → данные ещё остались; отдаём ровно limit
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}
