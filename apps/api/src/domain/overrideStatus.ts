import { sql, eq, and } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'

const ADVISORY_LOCK_KEY = 42_100_1 // same key as assignLead — overrides change ordering too, spec §0.1

export type OverrideStatusInput = {
  repId: string
  status: 'FORCE_ACTIVE' | 'FORCE_INACTIVE' | 'FOLLOW_SCHEDULE'
  reasonCode: string
  reasonNote: string
  actorUserId: string
}

const STATUS_TO_DAILY_STATUS = {
  FORCE_ACTIVE: 'ELIGIBLE',
  FORCE_INACTIVE: 'INELIGIBLE',
  FOLLOW_SCHEDULE: 'ELIGIBLE', // resolved by the next eligibility evaluation, not this override itself
} as const

export async function overrideStatus(db: DB, input: OverrideStatusInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

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

    if (before) {
      await tx
        .update(schema.repDailyStatus)
        .set({ status: newStatus, decidedBy: 'MANAGER_OVERRIDE', reason: input.reasonNote, updatedAt: new Date() })
        .where(eq(schema.repDailyStatus.id, before.id))
    } else {
      await tx.insert(schema.repDailyStatus).values({
        repId: input.repId,
        businessDate: today,
        status: newStatus,
        reason: input.reasonNote,
        decidedBy: 'MANAGER_OVERRIDE',
      })
    }

    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'rep.override',
      entityType: 'rep_daily_status',
      entityId: input.repId,
      before: before ? { status: before.status, decidedBy: before.decidedBy } : null,
      after: { status: newStatus, decidedBy: 'MANAGER_OVERRIDE' },
    })
  })
}
