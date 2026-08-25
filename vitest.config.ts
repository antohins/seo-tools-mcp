import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // e2e гоняет собранные dist — отдельным прогоном (pnpm test:e2e), см. vitest.e2e.config.ts
    exclude: ['tests/e2e/**'],
    // Юнит-тесты по умолчанию сетевые вызовы не делают; лайв-смоук — отдельным include-фильтром.
    environment: 'node',
  },
});
