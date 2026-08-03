import { sql, eq, and, inArray } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import { businessDatesThroughSaturday } from '../jobs/eligibility'
import { publishAssignment } from '../realtime/bus'

export const ADVISORY_LOCK_KEY = 42_100_1 // same key as assignLead — overrides change ordering too, spec §0.1

export type OverrideStatusInput = {
  repId: string
  status: 'FORCE_ACTIVE' | 'FORCE_INACTIVE'
  reasonCode: string
  reasonNote: string
  actorUserId: string
}

const STATUS_TO_DAILY_STATUS = {
  FORCE_ACTIVE: 'ELIGIBLE',
  FORCE_INACTIVE: 'INELIGIBLE',
} as const

export async function overrideStatus(db: DB, input: OverrideStatusInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)
    await applyOverrideStatus(tx, input)
  })
  publishAssignment({ type: 'ELIGIBILITY_UPDATED', statusDate: businessDate(new Date()) })
}

/**
 * One override, applied inside a transaction the caller already opened and locked.
 *
 * Split out so `bulkOverrideStatus` can apply many of these under a SINGLE
 * `pg_advisory_xact_lock`. Taking and releasing the lock once per rep would make a partial
 * apply reachable and would hold up an assigning BDC agent N times over.
 *
 * The caller MUST hold ADVISORY_LOCK_KEY. This function does not take it.
 */
export async function applyOverrideStatus(tx: any, input: OverrideStatusInput): Promise<void> {
  const today = businessDate(new Date())

  const before = await tx.query.repDailyStatus.findFirst({
    where: and(eq(schema.repDailyStatus.repId, input.repId), eq(schema.repDailyStatus.businessDate, today)),
  })

  await tx.insert(schema.statusOverride).values({
    repId: input.repId,
    status: input.status,
    reasonCode: input.reasonCode,
    reasonNote: input.reasonNote,
    actorUserId: input.actorUserId,
    businessDate: today,
  })

  const newStatus = STATUS_TO_DAILY_STATUS[input.status]

  // A week suspension writes INELIGIBLE for today AND every remaining business date through
  // Saturday (design pass §I). Touching only today would silently re-DQ the rep tomorrow,
  // so an override has to reach the whole tail it is undoing (or, for FORCE_INACTIVE, mirror it).
  const weekDates = businessDatesThroughSaturday(today)
  const futureDates = weekDates.filter((d) => d !== today)

  await upsertOverride(tx, input.repId, today, newStatus, input.reasonNote)

  if (input.status === 'FORCE_ACTIVE') {
    // clear the remaining WEEK_DQ tail — but only rows the SYSTEM wrote, so we never
    // stomp another manager's explicit future decision.
    if (futureDates.length > 0) {
      await tx
        .delete(schema.repDailyStatus)
        .where(
          and(
            eq(schema.repDailyStatus.repId, input.repId),
            inArray(schema.repDailyStatus.businessDate, futureDates),
            eq(schema.repDailyStatus.decidedBy, 'SYSTEM'),
            eq(schema.repDailyStatus.status, 'INELIGIBLE'),
          ),
        )
    }
  } else if (input.status === 'FORCE_INACTIVE') {
    // symmetric: write the deactivation through the end of the business week
    for (const date of futureDates) {
      await upsertOverride(tx, input.repId, date, 'INELIGIBLE', input.reasonNote)
    }
  }

  await tx.insert(schema.auditEvents).values({
    actorUserId: input.actorUserId,
    action: 'rep.override',
    entityType: 'rep_daily_status',
    entityId: input.repId,
    before: before ? { status: before.status, decidedBy: before.decidedBy, reason: before.reason } : null,
    after: {
      status: newStatus,
      decidedBy: 'MANAGER_OVERRIDE',
      reasonNote: input.reasonNote,
      // Reactivation only clears status rows — it never marks a rep exempt, so the rep is
      // still subject to the daily call qualifier the next morning (design pass §I).
      appliedThrough: weekDates[weekDates.length - 1],
    },
  })
}

async function upsertOverride(
  tx: any,
  repId: string,
  businessDateStr: string,
  status: 'ELIGIBLE' | 'INELIGIBLE',
  reasonNote: string,
): Promise<void> {
  const existing = await tx.query.repDailyStatus.findFirst({
    where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, businessDateStr)),
  })
  if (existing) {
    await tx
      .update(schema.repDailyStatus)
      .set({ status, decidedBy: 'MANAGER_OVERRIDE', reason: reasonNote, updatedAt: new Date() })
      .where(eq(schema.repDailyStatus.id, existing.id))
  } else {
    await tx.insert(schema.repDailyStatus).values({
      repId,
      businessDate: businessDateStr,
      status,
      reason: reasonNote,
      decidedBy: 'MANAGER_OVERRIDE',
    })
  }
}
