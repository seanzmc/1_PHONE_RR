import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index'

/**
 * No fallback connection string, deliberately. A default of localhost meant a deploy with
 * DATABASE_URL unset would boot, pass its healthcheck and serve an empty database — the
 * failure only surfaced when someone tried to assign a lead. Fail at import instead.
 */
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Refusing to start with a fallback connection — see .env.example. ' +
      'For local work: DATABASE_URL=postgresql://localhost/phoneup_dev',
  )
}

const queryClient = postgres(connectionString)

export const db = drizzle(queryClient, { schema })
export { schema }
export type DB = typeof db
