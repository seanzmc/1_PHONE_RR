import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // All tests hit the same live Postgres test DB (no per-file isolation),
    // so file-level parallelism causes cross-test interference on shared tables.
    fileParallelism: false,
    env: {
      DATABASE_URL: 'postgresql://localhost/phoneup_test',
    },
  },
})
