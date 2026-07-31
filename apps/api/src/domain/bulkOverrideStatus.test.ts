import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq, and, inArray } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import { bulkOverrideStatus } from './bulkOverrideStatus'
import { businessDatesThroughSaturday } from '../jobs/eligibility'

let repIds: string[] = []
let managerUserId: string
const today = businessDate(new Date())

beforeAll(async () => {
  const reps = await db.select().from(schema.salesRep)
  repIds = reps.map((r: any) => r.id).slice(0, 3)
  const [manager] = await db
    .insert(schema.appUser)
    .values({ email: `bulk-test-manager-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'MANAGER' })
    .returning()
  managerUserId = manager.id
})

/** Put the given reps at a known starting status so each test controls its own inputs. */
async function setStatus(
  ids: string[],
  status: 'ELIGIBLE' | 'INELIGIBLE',
  decidedBy: 'SYSTEM' | 'MANAGER_OVERRIDE',
) {
  for (const repId of ids) {
    const existing = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
    })
    if (existing) {
      await db
        .update(schema.repDailyStatus)
        .set({ status, decidedBy, reason: 'test fixture' })
        .where(eq(schema.repDailyStatus.id, existing.id))
    } else {
      await db
        .insert(schema.repDailyStatus)
        .values({ repId, businessDate: today, status, decidedBy, reason: 'test fixture' })
    }
  }
}

beforeEach(async () => {
  await db.delete(schema.statusOverride).where(inArray(schema.statusOverride.repId, repIds))
  await db
    .delete(schema.repDailyStatus)
    .where(
      and(
        inArray(schema.repDailyStatus.repId, repIds),
        inArray(schema.repDailyStatus.businessDate, businessDatesThroughSaturday(today)),
      ),
    )
})

describe('bulkOverrideStatus', () => {
  it('deactivates every eligible rep in one call, through Saturday', async () => {
    await setStatus(repIds, 'ELIGIBLE', 'SYSTEM')

    const result = await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_INACTIVE',
      reasonCode: 'BELOW_CALL_MINIMUM',
      reasonNote: 'Below call minimum',
      actorUserId: managerUserId,
    })

    expect(result.applied.sort()).toEqual([...repIds].sort())
    expect(result.skipped).toEqual([])

    const weekDates = businessDatesThroughSaturday(today)
    for (const repId of repIds) {
      const rows = await db.query.repDailyStatus.findMany({
        where: and(
          eq(schema.repDailyStatus.repId, repId),
          inArray(schema.repDailyStatus.businessDate, weekDates),
        ),
      })
      expect(rows.length).toBe(weekDates.length)
      expect(rows.every((r: any) => r.status === 'INELIGIBLE')).toBe(true)
      expect(rows.every((r: any) => r.decidedBy === 'MANAGER_OVERRIDE')).toBe(true)
    }
  })

  it('writes one status_override and one audit event per applied rep', async () => {
    await setStatus(repIds, 'ELIGIBLE', 'SYSTEM')

    await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_INACTIVE',
      reasonCode: 'PTO',
      reasonNote: 'PTO',
      actorUserId: managerUserId,
    })

    const overrides = await db.query.statusOverride.findMany({
      where: inArray(schema.statusOverride.repId, repIds),
    })
    expect(overrides.length).toBe(repIds.length)
    expect(overrides.every((o: any) => o.reasonCode === 'PTO')).toBe(true)

    // Per-rep, not per-batch: the audit screen and the rep drill-down both query by
    // entityId, and a batch-shaped event would leave a rep's own history incomplete.
    for (const repId of repIds) {
      const audit = await db.query.auditEvents.findMany({
        where: and(
          eq(schema.auditEvents.entityType, 'rep_daily_status'),
          eq(schema.auditEvents.entityId, repId),
          eq(schema.auditEvents.actorUserId, managerUserId),
        ),
      })
      expect(audit.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('skips reps the action would not change, writing nothing for them', async () => {
    const [alreadyOut, ...eligible] = repIds
    await setStatus([alreadyOut], 'INELIGIBLE', 'MANAGER_OVERRIDE')
    await setStatus(eligible, 'ELIGIBLE', 'SYSTEM')

    const result = await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_INACTIVE',
      reasonCode: 'DISCIPLINARY',
      reasonNote: 'Disciplinary',
      actorUserId: managerUserId,
    })

    expect(result.skipped).toEqual([alreadyOut])
    expect(result.applied.sort()).toEqual([...eligible].sort())

    const skippedOverrides = await db.query.statusOverride.findMany({
      where: eq(schema.statusOverride.repId, alreadyOut),
    })
    expect(skippedOverrides.length).toBe(0)
  })

  it('reactivating a batch clears each rep SYSTEM ineligible tail', async () => {
    const weekDates = businessDatesThroughSaturday(today)
    const futureDates = weekDates.filter((d) => d !== today)
    await setStatus(repIds, 'INELIGIBLE', 'SYSTEM')
    for (const repId of repIds) {
      for (const date of futureDates) {
        await db
          .insert(schema.repDailyStatus)
          .values({ repId, businessDate: date, status: 'INELIGIBLE', decidedBy: 'SYSTEM', reason: 'WEEK_DQ' })
      }
    }

    const result = await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_ACTIVE',
      reasonCode: 'SUSPENSION_LIFTED',
      reasonNote: 'Suspension lifted early',
      actorUserId: managerUserId,
    })
    expect(result.applied.length).toBe(repIds.length)

    for (const repId of repIds) {
      const todayRow = await db.query.repDailyStatus.findFirst({
        where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
      })
      expect(todayRow?.status).toBe('ELIGIBLE')

      if (futureDates.length > 0) {
        const tail = await db.query.repDailyStatus.findMany({
          where: and(
            eq(schema.repDailyStatus.repId, repId),
            inArray(schema.repDailyStatus.businessDate, futureDates),
          ),
        })
        expect(tail).toEqual([])
      }
    }
  })

  it('reactivating a batch leaves another manager future decision alone', async () => {
    const weekDates = businessDatesThroughSaturday(today)
    const futureDates = weekDates.filter((d) => d !== today)
    if (futureDates.length === 0) return // Saturday: no tail to protect

    const [protectedRep, ...rest] = repIds
    await setStatus(repIds, 'INELIGIBLE', 'SYSTEM')
    // One rep carries an explicit manager decision for a future date. A batch reactivation
    // clears the SYSTEM week tail; it must not stomp this.
    await db.insert(schema.repDailyStatus).values({
      repId: protectedRep,
      businessDate: futureDates[0],
      status: 'INELIGIBLE',
      decidedBy: 'MANAGER_OVERRIDE',
      reason: 'suspended by another manager',
    })
    for (const repId of rest) {
      await db.insert(schema.repDailyStatus).values({
        repId,
        businessDate: futureDates[0],
        status: 'INELIGIBLE',
        decidedBy: 'SYSTEM',
        reason: 'WEEK_DQ',
      })
    }

    await bulkOverrideStatus(db, {
      repIds,
      status: 'FORCE_ACTIVE',
      reasonCode: 'DEACTIVATED_IN_ERROR',
      reasonNote: 'Deactivated in error',
      actorUserId: managerUserId,
    })

    const kept = await db.query.repDailyStatus.findFirst({
      where: and(
        eq(schema.repDailyStatus.repId, protectedRep),
        eq(schema.repDailyStatus.businessDate, futureDates[0]),
      ),
    })
    expect(kept?.status).toBe('INELIGIBLE')
    expect(kept?.decidedBy).toBe('MANAGER_OVERRIDE')

    for (const repId of rest) {
      const cleared = await db.query.repDailyStatus.findFirst({
        where: and(
          eq(schema.repDailyStatus.repId, repId),
          eq(schema.repDailyStatus.businessDate, futureDates[0]),
        ),
      })
      expect(cleared).toBeUndefined()
    }
  })

  it('rolls the whole batch back when one rep fails', async () => {
    await setStatus(repIds, 'ELIGIBLE', 'SYSTEM')
    const bogusRepId = '00000000-0000-0000-0000-000000000000'

    await expect(
      bulkOverrideStatus(db, {
        repIds: [...repIds, bogusRepId],
        status: 'FORCE_INACTIVE',
        reasonCode: 'PTO',
        reasonNote: 'PTO',
        actorUserId: managerUserId,
      }),
    ).rejects.toThrow()

    // Partial success is not a state a manager should have to reason about.
    const overrides = await db.query.statusOverride.findMany({
      where: inArray(schema.statusOverride.repId, repIds),
    })
    expect(overrides.length).toBe(0)

    for (const repId of repIds) {
      const row = await db.query.repDailyStatus.findFirst({
        where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
      })
      expect(row?.status).toBe('ELIGIBLE')
    }
  })
})
