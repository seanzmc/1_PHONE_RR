import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index'

const connectionString = process.env.DATABASE_URL ?? 'postgresql://localhost/phoneup_dev'

const queryClient = postgres(connectionString)

export const db = drizzle(queryClient, { schema })
export { schema }
export type DB = typeof db
