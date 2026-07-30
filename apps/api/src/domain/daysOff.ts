import { sql, eq, and, inArray, gte } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import { materializeShifts } from '../jobs/eligibility'

const ADVISORY_LOCK_KEY = 42_100_1 // changing days off changes ordering — same lock (CLAUDE.md)

export type SetDaysOffInput = {
  repId: string
  /** 0=Sunday..6=Saturday. Sunday is store-closed and is ignored if passed. */
  daysOfWeek: number[]
  actorUserId: string
}

/**
 * Set a rep's recurring weekly days off (design pass §I) and re-materialize their FUTURE
 * shift rows only — a past date is eligibility evidence and is never rewritten.
 * Manually-set PTO/SICK/TRAINING rows survive, because materializeShifts only touches
 * rows it generated itself.
 */
export async function setRecurringDaysOff(db: DB, input: SetDaysOffInput): Promise<{ daysOff: number[] }> {
  // Sunday needs no rep-level entry (the store is closed) and shouldn't consume one.
  const requested = Array.from(new Set(input.daysOfWeek.filter((d) => d >= 1 && d <= 6))).sort()

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const before = await tx
      .select()
      .from(schema.repRecurringDayOff)
      .where(eq(schema.repRecurringDayOff.repId, input.repId))
    const beforeDays = before.map((r: any) => r.dayOfWeek).sort()

    await tx.delete(schema.repRecurringDayOff).where(eq(schema.repRecurringDayOff.repId, input.repId))
    if (requested.length > 0) {
      await tx
        .insert(schema.repRecurringDayOff)
        .values(requested.map((dayOfWeek) => ({ repId: input.repId, dayOfWeek })))
    }

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'rep.days_off.set',
      entityType: 'sales_rep',
      entityId: input.repId,
      before: { daysOfWeek: beforeDays },
      after: { daysOfWeek: requested },
    })
  })

  // Re-materialize forward from today only — never a past date.
  await materializeShifts(db, { fromDate: businessDate(new Date()), repIds: [input.repId] })

  return { daysOff: requested }
}

export async function getRecurringDaysOff(db: DB, repId: string): Promise<number[]> {
  const rows = await db
    .select()
    .from(schema.repRecurringDayOff)
    .where(eq(schema.repRecurringDayOff.repId, repId))
  return rows.map((r: any) => r.dayOfWeek).sort()
}

export async function getRecurringDaysOffForReps(db: DB, repIds: string[]): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  if (repIds.length === 0) return out
  const rows = await db
    .select()
    .from(schema.repRecurringDayOff)
    .where(inArray(schema.repRecurringDayOff.repId, repIds))
  for (const row of rows) {
    if (!out.has(row.repId)) out.set(row.repId, [])
    out.get(row.repId)!.push(row.dayOfWeek)
  }
  for (const list of out.values()) list.sort()
  return out
}

/** Upcoming shift rows for a rep, for the staff-list schedule preview. */
export async function getUpcomingShifts(
  db: DB,
  repId: string,
  days = 14,
): Promise<Array<{ businessDate: string; kind: string }>> {
  const from = businessDate(new Date())
  const rows = await db
    .select()
    .from(schema.repShift)
    .where(and(eq(schema.repShift.repId, repId), gte(schema.repShift.businessDate, from)))
  return rows
    .map((r: any) => ({ businessDate: r.businessDate, kind: r.kind }))
    .sort((a, b) => (a.businessDate < b.businessDate ? -1 : 1))
    .slice(0, days)
}
