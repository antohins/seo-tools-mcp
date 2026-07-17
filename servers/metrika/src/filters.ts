/** Хелперы фильтров Метрики — вынесено из index.ts для тестируемости. */

/** Экранирование значения в выражении фильтра Метрики: \ и ' внутри '...' */
export const escFilter = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Строит фильтр по странице входа без привязки к origin/домену:
 *  - полный URL (http…) → точное совпадение ym:s:startURL;
 *  - относительный путь → ym:s:startURLPath.
 * Оговорка: startURLPath отбрасывает домен и query-string — для мультидоменного
 * счётчика одинаковые пути разных доменов схлопнутся в одну строку.
 */
export function landingFilter(landing: string): string {
  const l = landing.trim();
  const dim = l.startsWith('http') ? 'ym:s:startURL' : 'ym:s:startURLPath';
  return `${dim}=='${escFilter(l)}'`;
}
