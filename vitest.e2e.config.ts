import { defineConfig } from 'vitest/config';

/**
 * E2E по протоколу: поднимает СОБРАННЫЕ серверы (`servers/<name>/dist`) как stdio-процессы
 * и разговаривает с ними настоящим MCP-клиентом. Юнит-тесты бьют по исходникам и
 * поэтому не видят поломок сборки — а в npm уезжает именно dist.
 * Сети не требует: дёргаются только локальные инструменты. Запуск: `pnpm test:e2e`.
 */
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
