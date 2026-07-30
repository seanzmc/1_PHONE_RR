import { defineConfig } from 'drizzle-kit'

// No fallback: `migrate` with DATABASE_URL unset must not quietly target a local database
// while the operator believes they are migrating production.
const url = process.env.DATABASE_URL
if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Refusing to run drizzle-kit against a fallback connection — see .env.example.',
  )
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
})
