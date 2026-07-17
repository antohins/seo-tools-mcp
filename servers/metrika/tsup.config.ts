import { defineConfig } from 'tsup';

// @seo-tools/shared (в devDependencies) бандлится в единый dist/index.js;
// рантайм-зависимости из dependencies остаются external и ставятся у пользователя.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
});
