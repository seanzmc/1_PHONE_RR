import { sql, eq, inArray } from 'drizzle-orm'
import type { BulkSetDaysOffInput } from '@phoneup/contracts'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import { materializeShiftsLocked } from '../jobs/eligibility'
import { publishAssignment } from '../realtime/bus'
import { selectActiveReps } from './activeReps'

const ADVISORY_LOCK_KEY = 42_100_1 // changing days off changes ordering — same lock (CLAUDE.md)

export type SetDaysOffInput = {
  repId: string
  /** 0=Sunday..6=Saturday. Sunday is store-closed and is ignored if passed. */
  daysOfWeek: number[]
  actorUserId: string
}

export type BulkSetDaysOffDomainInput = BulkSetDaysOffInput & { actorUserId: string }

function normalizeRecurringDaysOff(daysOfWeek: number[]): number[] {
  const invalidDays = daysOfWeek.filter((day) => !Number.isInteger(day) || day < 0 || day > 6)
  if (invalidDays.length > 0) {
    throw new Error(`a weekday must be an integer from 0 to 6, got: ${invalidDays.join(', ')}`)
  }

  // Sunday needs no rep-level entry (the store is closed) and shouldn't consume one.
  const requested = Array.from(new Set(daysOfWeek.filter((day) => day !== 0))).sort()

  if (requested.length > 1) {
    throw new Error(
      `a rep can have at most one recurring day off, got ${requested.length}: ${requested.join(', ')}`,
    )
  }

  return requested
}

function sameDays(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((day, index) => day === right[index])
}

/**
 * Save one or more reps' recurring days off atomically under the rotation lock.
 * Every target must still be active when the lock is held; changed rows, their audit
 * events, and forward shift materialization all commit or roll back together.
 */
export async function bulkSetRecurringDaysOff(db: DB, input: BulkSetDaysOffDomainInput) {
  const normalized = input.changes.map(({ repId, daysOfWeek }) => ({
    repId,
    daysOff: normalizeRecurringDaysOff(daysOfWeek),
  }))

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const activeRepIds = new Set((await selectActiveReps(tx)).map((rep: any) => rep.id))
    const invalidRepIds = normalized
      .map(({ repId }) => repId)
      .filter((repId) => !activeRepIds.has(repId))
    if (invalidRepIds.length > 0) {
      throw new Error(`bulkSetRecurringDaysOff: unknown or inactive repId(s): ${invalidRepIds.join(', ')}`)
    }

    const targetRepIds = normalized.map(({ repId }) => repId)
    const currentRows = await tx
      .select()
      .from(schema.repRecurringDayOff)
      .where(inArray(schema.repRecurringDayOff.repId, targetRepIds))
    const currentByRep = new Map<string, number[]>()
    for (const row of currentRows) {
      if (!currentByRep.has(row.repId)) currentByRep.set(row.repId, [])
      currentByRep.get(row.repId)!.push(row.dayOfWeek)
    }
    for (const days of currentByRep.values()) days.sort()

    const changedRepIds: string[] = []
    const daysOffByRep: Record<string, number[]> = {}
    for (const { repId, daysOff } of normalized) {
      const beforeDays = currentByRep.get(repId) ?? []
      daysOffByRep[repId] = daysOff
      if (sameDays(beforeDays, daysOff)) continue

      await tx.delete(schema.repRecurringDayOff).where(eq(schema.repRecurringDayOff.repId, repId))
      if (daysOff.length > 0) {
        await tx
          .insert(schema.repRecurringDayOff)
          .values(daysOff.map((dayOfWeek) => ({ repId, dayOfWeek })))
      }
      await tx.insert(schema.auditEvents).values({
        actorUserId: input.actorUserId,
        action: 'rep.days_off.set',
        entityType: 'sales_rep',
        entityId: repId,
        before: { daysOfWeek: beforeDays },
        after: { daysOfWeek: daysOff },
      })
      changedRepIds.push(repId)
    }

    if (changedRepIds.length > 0) {
      await materializeShiftsLocked(tx, {
        fromDate: businessDate(new Date()),
        repIds: changedRepIds,
      })
    }

    return { changedRepIds, daysOffByRep }
  })

  if (result.changedRepIds.length > 0) {
    publishAssignment({ type: 'ELIGIBILITY_UPDATED', statusDate: businessDate(new Date()) })
  }
  return result
}

/**
 * Set a rep's recurring weekly day off — at most one, or none — and re-materialize their
 * FUTURE shift rows only; a past date is eligibility evidence and is never rewritten.
 * Manually-set PTO/SICK/TRAINING rows survive, because materializeShifts only touches
 * rows it generated itself. Multi-day absence belongs in those shift kinds, not here.
 */
export async function setRecurringDaysOff(db: DB, input: SetDaysOffInput): Promise<{ daysOff: number[] }> {
  const result = await bulkSetRecurringDaysOff(db, {
    actorUserId: input.actorUserId,
    changes: [{ repId: input.repId, daysOfWeek: input.daysOfWeek }],
  })
  return { daysOff: result.daysOffByRep[input.repId] }
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
