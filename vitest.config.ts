import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Юнит-тесты по умолчанию сетевые вызовы не делают; лайв-смоук — отдельным include-фильтром.
    environment: 'node',
  },
});
