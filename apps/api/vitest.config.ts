import { defineConfig } from 'vitest/config'

/**
 * Deliberately reads TEST_DATABASE_URL, not DATABASE_URL: a developer with DATABASE_URL
 * exported to a real database must never have the suite run against it. CI sets
 * TEST_DATABASE_URL because its Postgres service needs credentials.
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/phoneup_test'

// These tests insert, update and delete freely. Refuse anything that isn't obviously a
// test database — a mistyped override should fail, not truncate production.
const databaseName = new URL(testDatabaseUrl).pathname.replace(/^\//, '')
if (!databaseName.includes('test')) {
  throw new Error(
    `refusing to run tests against database "${databaseName}": the name must contain "test". ` +
      'These tests write destructively.',
  )
}

export default defineConfig({
  test: {
    // All tests hit the same live Postgres test DB (no per-file isolation),
    // so file-level parallelism causes cross-test interference on shared tables.
    fileParallelism: false,
    env: {
      DATABASE_URL: testDatabaseUrl,
    },
  },
})
