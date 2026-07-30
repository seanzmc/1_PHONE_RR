import { sql } from 'drizzle-orm'
import { db } from '@phoneup/db'
import { publicProcedure } from '../trpc/router'

/**
 * A health check that does not touch the database is worthless here: the process starts
 * fine without a reachable Postgres, and every route that matters then fails. Round-trip
 * one query so "healthy" means "can serve an assignment".
 */
export async function checkDatabase(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`)
    return true
  } catch {
    return false
  }
}

export const healthQuery = publicProcedure.query(async () => ({ ok: await checkDatabase() }))
