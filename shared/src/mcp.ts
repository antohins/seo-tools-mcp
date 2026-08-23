import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Успешный ответ инструмента: строго JSON. */
export function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/** Структурированная ошибка инструмента (isError, но с machine-readable JSON). */
export function errorResult(message: string, details?: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, details: details ?? null }, null, 2),
      },
    ],
  };
}

/**
 * Обёртка хендлера: ловит исключения и возвращает их структурно,
 * чтобы MCP-клиент видел понятную ошибку, а не упавший процесс.
 */
export function safeHandler<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tool error] ${message}`);
      return errorResult(message);
    }
  };
}

/** Бренд сервера для человекочитаемых заголовков инструментов. */
const BRANDS: Record<string, string> = {
  xmlstock: 'XMLStock',
  xmlriver: 'XMLRiver',
  wordstat: 'Wordstat',
  gsc: 'Search Console',
  ga4: 'GA4',
  ywm: 'Яндекс.Вебмастер',
  metrika: 'Яндекс.Метрика',
  aparser: 'A-Parser',
};

/** `ga4_top_pages` → «GA4: top pages». Префикс сервера заменяется на бренд. */
function deriveTitle(toolName: string): string {
  const [prefix, ...rest] = toolName.split('_');
  const brand = BRANDS[prefix] ?? prefix;
  return rest.length ? `${brand}: ${rest.join(' ')}` : brand;
}

/**
 * Проставляет всем инструментам сервера аннотации и заголовок.
 *
 * Зачем: read-only — заявленное свойство всего набора, но клиенты (в т.ч. Claude)
 * читают его из `annotations.readOnlyHint` и без него спрашивают подтверждение
 * на безопасные вызовы. Патчим один раз на сервер, а не в 98 местах регистрации.
 *
 * Умолчания: readOnlyHint=true (ничего не меняем в аккаунтах пользователя) и
 * openWorldHint=true (ходим во внешние API). ВАЖНО: инструменты, которые реально
 * пишут (сохранение ключей, OAuth), обязаны переопределить readOnlyHint на false —
 * иначе аннотация станет ровно тем «молча неверным» фактом, который она должна убрать.
 */
type ToolRegistrar = { registerTool: (name: string, config: Record<string, unknown>, handler: unknown) => unknown };

export function withToolDefaults<T>(server: T): T {
  const target = server as unknown as ToolRegistrar;
  const original = target.registerTool.bind(target);
  target.registerTool = (name: string, config: Record<string, unknown>, handler: unknown) =>
    original(
      name,
      {
        title: deriveTitle(name),
        ...config,
        annotations: { readOnlyHint: true, openWorldHint: true, ...((config.annotations as object) ?? {}) },
      },
      handler,
    );
  return server;
}
