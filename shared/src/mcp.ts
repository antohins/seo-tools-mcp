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
