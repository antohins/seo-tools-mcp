/**
 * Счётчик платных вызовов (XMLStock и т.п.).
 * Пишет в stderr число вызовов и оценку расхода — stdout занят протоколом MCP.
 */
export class CostLogger {
  private calls = 0;
  private spent = 0;

  constructor(
    private label: string,
    /** цена одного вызова в рублях; функция — чтобы читать актуальный конфиг лениво */
    private pricePerCallRub: number | (() => number),
  ) {}

  track(what: string, units = 1): void {
    const price = typeof this.pricePerCallRub === 'function' ? this.pricePerCallRub() : this.pricePerCallRub;
    this.calls += units;
    this.spent += units * price;
    const spentPart = price > 0 ? `, ~расход: ${this.spent.toFixed(2)} ₽` : '';
    console.error(`[${this.label}] ${what} — вызовов за сессию: ${this.calls}${spentPart}`);
  }
}
