import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq, and, isNull, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, schema } from '@phoneup/db'
import { rankReps, businessDate, periodKey, type RepRankInput } from '@phoneup/core'
import { assignLead } from './assignLead'
import { voidLead } from './voidLead'

let repIds: string[] = []
let bdcUserId: string

function hashRepIdToSeed(repId: string): number {
  let h = 0
  for (const c of repId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}

/** Mirrors board.roster's ranking so the test asserts what the UI would actually show. */
async function nextUpRepId(): Promise<string | null> {
  const bDate = businessDate(new Date())
  const pKey = periodKey(bDate)
  const reps = await db.select().from(schema.salesRep)
  const statuses = await db.query.repDailyStatus.findMany({
    where: eq(schema.repDailyStatus.businessDate, bDate),
  })
  const counters = await db.query.repMonthCounters.findMany({
    where: eq(schema.repMonthCounters.periodKey, pKey),
  })
  const cycle = await db.query.rotationCycle.findFirst({ where: isNull(schema.rotationCycle.closedAt) })
  const served = cycle
    ? await db.query.rrCycleAssignments.findMany({ where: eq(schema.rrCycleAssignments.cycleId, cycle.id) })
    : []

  const statusByRep = new Map(statuses.map((s: any) => [s.repId, s]))
  const counterByRep = new Map(counters.map((c: any) => [c.repId, c]))
  const servedSet = new Set(served.map((s: any) => s.repId))

  const inputs: RepRankInput[] = reps.map((rep: any) => ({
    repId: rep.id,
    isEligible: statusByRep.get(rep.id)?.status === 'ELIGIBLE',
    servedThisCycle: servedSet.has(rep.id),
    monthlyLoad: counterByRep.get(rep.id)?.upsMtd ?? 0,
    lastAssignedAt: counterByRep.get(rep.id)?.lastAssignedAt?.toISOString() ?? null,
    rotationSeed: hashRepIdToSeed(rep.id),
  }))

  const ranked = rankReps(inputs)
  return ranked.find((r) => r.isEligible && !r.servedThisCycle)?.repId ?? null
}

beforeAll(async () => {
  const reps = await db.select().from(schema.salesRep)
  repIds = reps.map((r: any) => r.id)
  const bdc = await db.query.appUser.findFirst({ where: eq(schema.appUser.role, 'BDC') })
  bdcUserId = bdc!.id
})

beforeEach(async () => {
  await db.delete(schema.assignmentEvents)
  await db.delete(schema.rrCycleAssignments)
  await db.delete(schema.unassignedQueue)
  await db.delete(schema.lead)
  await db.delete(schema.customer)
  await db.delete(schema.repMonthCounters)
  // collapse back to exactly one open cycle
  await db.delete(schema.rrState)
  await db.delete(schema.rotationCycle)
  const [cycle] = await db.insert(schema.rotationCycle).values({}).returning()
  await db.insert(schema.rrState).values({ currentCycleId: cycle.id, version: 0 })
})

async function assignOne(label: string, phoneSuffix: string) {
  return assignLead(db, {
    idempotencyKey: randomUUID(),
    customerName: label,
    customerPhoneE164: `+1555${phoneSuffix}`,
    actorUserId: bdcUserId,
  })
}

/**
 * Narrow today's eligible set to `keepRepIds` for the duration of `body`, then restore.
 * The shared test DB has accumulated hundreds of reps, so tests that need to fill a whole
 * rotation cycle scope it down instead of issuing one assign per rep.
 */
async function withOnlyEligible(keepRepIds: string[], body: () => Promise<void>): Promise<void> {
  const bDate = businessDate(new Date())
  const keep = new Set(keepRepIds)
  const rows = await db.query.repDailyStatus.findMany({
    where: eq(schema.repDailyStatus.businessDate, bDate),
  })
  const toSuppress = rows.filter((r: any) => !keep.has(r.repId))

  await db
    .update(schema.repDailyStatus)
    .set({ status: 'INELIGIBLE', reason: 'test: scoped out' })
    .where(eq(schema.repDailyStatus.businessDate, bDate))
  await db
    .update(schema.repDailyStatus)
    .set({ status: 'ELIGIBLE', reason: null })
    .where(and(eq(schema.repDailyStatus.businessDate, bDate), inArray(schema.repDailyStatus.repId, keepRepIds)))

  try {
    await body()
  } finally {
    for (const row of toSuppress) {
      await db
        .update(schema.repDailyStatus)
        .set({ status: row.status, reason: row.reason })
        .where(eq(schema.repDailyStatus.id, row.id))
    }
  }
}

describe('voidLead', () => {
  it('undo makes the voided rep next-up again', async () => {
    const assigned = await assignOne('Void Target', '9110001')
    expect(assigned.assignedRepId).toBeTruthy()

    // after the assign, the rep is served this cycle so they are NOT next up
    expect(await nextUpRepId()).not.toBe(assigned.assignedRepId)

    await voidLead(db, { leadId: assigned.leadId, reasonNote: 'wrong rep', actorUserId: bdcUserId })

    // the whole point of A: undo hands the up straight back to the same rep
    expect(await nextUpRepId()).toBe(assigned.assignedRepId)
  })

  it('rolls back the cycle slot, the counters and last_assigned_at', async () => {
    const assigned = await assignOne('Rollback', '9110002')
    const repId = assigned.assignedRepId!
    const pKey = periodKey(businessDate(new Date()))

    const afterAssign = await db.query.repMonthCounters.findFirst({
      where: and(eq(schema.repMonthCounters.repId, repId), eq(schema.repMonthCounters.periodKey, pKey)),
    })
    expect(afterAssign?.upsMtd).toBe(1)
    expect(afterAssign?.upsToday).toBe(1)
    expect(afterAssign?.lastAssignedAt).toBeTruthy()

    await voidLead(db, { leadId: assigned.leadId, reasonNote: 'undo', actorUserId: bdcUserId })

    const afterVoid = await db.query.repMonthCounters.findFirst({
      where: and(eq(schema.repMonthCounters.repId, repId), eq(schema.repMonthCounters.periodKey, pKey)),
    })
    expect(afterVoid?.upsMtd).toBe(0)
    expect(afterVoid?.upsToday).toBe(0)
    // no previous ASSIGN for this rep this period -> restored to null, not left stale
    expect(afterVoid?.lastAssignedAt).toBeNull()

    // the rr_cycle_assignments row is gone, so the rep is unserved again
    const slots = await db.query.rrCycleAssignments.findMany({
      where: eq(schema.rrCycleAssignments.repId, repId),
    })
    expect(slots.length).toBe(0)

    // ledger stayed append-only: ASSIGN survives, VOID is appended
    const events = await db.query.assignmentEvents.findMany({
      where: eq(schema.assignmentEvents.leadId, assigned.leadId),
    })
    expect(events.some((e: any) => e.eventType === 'ASSIGN')).toBe(true)
    expect(events.some((e: any) => e.eventType === 'VOID')).toBe(true)
  })

  it('restores last_assigned_at to the previous ASSIGN, not to null, when one exists', async () => {
    // force two assigns onto the same rep so there is a prior ASSIGN to restore to
    const repId = repIds[0]
    const first = await assignLead(db, {
      idempotencyKey: randomUUID(),
      customerName: 'First',
      customerPhoneE164: '+15559110003',
      forcedRepId: repId,
      actorUserId: bdcUserId,
    })
    const second = await assignLead(db, {
      idempotencyKey: randomUUID(),
      customerName: 'Second',
      customerPhoneE164: '+15559110004',
      forcedRepId: repId,
      actorUserId: bdcUserId,
    })
    expect(first.assignedRepId).toBe(repId)
    expect(second.assignedRepId).toBe(repId)

    const firstAssignEvent = await db.query.assignmentEvents.findFirst({
      where: and(
        eq(schema.assignmentEvents.leadId, first.leadId),
        eq(schema.assignmentEvents.eventType, 'ASSIGN'),
      ),
    })

    await voidLead(db, { leadId: second.leadId, reasonNote: 'undo second', actorUserId: bdcUserId })

    const pKey = periodKey(businessDate(new Date()))
    const counter = await db.query.repMonthCounters.findFirst({
      where: and(eq(schema.repMonthCounters.repId, repId), eq(schema.repMonthCounters.periodKey, pKey)),
    })
    expect(counter?.upsMtd).toBe(1)
    expect(counter?.lastAssignedAt?.toISOString()).toBe(firstAssignEvent!.createdAt.toISOString())
  })

  it('undo across a cycle boundary reopens the closed cycle instead of jumping a rotation', async () => {
    // Scope the rotation to exactly two eligible reps so "fill the whole cycle" is two
    // assigns rather than one per rep in the shared test DB.
    await withOnlyEligible([repIds[0], repIds[1]], async () => {
      const first = await assignOne('Cycle Fill 1', '9220001')
      const last = await assignOne('Cycle Fill 2', '9220002')
      expect(first.assignedRepId).toBeTruthy()
      expect(last.assignedRepId).toBeTruthy()
      expect(last.assignedRepId).not.toBe(first.assignedRepId)

      const closedCycleId = (await lastAssignCycle(last.leadId))!
      const closedCycle = await db.query.rotationCycle.findFirst({
        where: eq(schema.rotationCycle.id, closedCycleId),
      })
      expect(closedCycle?.closedAt).toBeTruthy()
      const cyclesBefore = await db.select().from(schema.rotationCycle)
      expect(cyclesBefore.length).toBe(2) // the closed one + the freshly opened empty one

      await voidLead(db, { leadId: last.leadId, reasonNote: 'undo last of cycle', actorUserId: bdcUserId })

      // the empty successor is gone and the original cycle is open again
      const cyclesAfter = await db.select().from(schema.rotationCycle)
      expect(cyclesAfter.length).toBe(1)
      expect(cyclesAfter[0].id).toBe(closedCycleId)
      expect(cyclesAfter[0].closedAt).toBeNull()

      // and the rotation did not jump: the voided rep is next up
      expect(await nextUpRepId()).toBe(last.assignedRepId)
    })
  })

  it('is idempotent — a second void does not double-decrement', async () => {
    const assigned = await assignOne('Double Void', '9110005')
    const repId = assigned.assignedRepId!

    await voidLead(db, { leadId: assigned.leadId, reasonNote: 'first', actorUserId: bdcUserId })
    const second = await voidLead(db, {
      leadId: assigned.leadId,
      reasonNote: 'second',
      actorUserId: bdcUserId,
    })
    expect(second.alreadyVoided).toBe(true)

    const pKey = periodKey(businessDate(new Date()))
    const counter = await db.query.repMonthCounters.findFirst({
      where: and(eq(schema.repMonthCounters.repId, repId), eq(schema.repMonthCounters.periodKey, pKey)),
    })
    expect(counter?.upsMtd).toBe(0) // never negative, never double-applied
  })

  it('concurrent void + assign stay consistent under the shared advisory lock', async () => {
    const first = await assignOne('Concurrent Base', '9110006')

    const [, secondAssign] = await Promise.all([
      voidLead(db, { leadId: first.leadId, reasonNote: 'race', actorUserId: bdcUserId }),
      assignOne('Concurrent Racer', '9110007'),
    ])

    expect(secondAssign.assignedRepId).toBeTruthy()

    // exactly one live ASSIGN remains, and the ledger totals agree with the counters
    const liveLeads = await db.query.lead.findMany({ where: eq(schema.lead.status, 'ASSIGNED') })
    expect(liveLeads.length).toBe(1)

    const counters = await db.query.repMonthCounters.findMany()
    const total = counters.reduce((sum: number, c: any) => sum + c.upsMtd, 0)
    expect(total).toBe(1)
    expect(counters.every((c: any) => c.upsMtd >= 0)).toBe(true)

    // no rep holds a cycle slot they no longer earned
    const slots = await db.query.rrCycleAssignments.findMany()
    expect(slots.length).toBe(1)
    expect(slots[0].repId).toBe(secondAssign.assignedRepId)
  })

  it('voids an unassigned (queued) lead without touching rotation state', async () => {
    // make everyone ineligible so the lead lands in the unassigned queue
    const bDate = businessDate(new Date())
    await db
      .update(schema.repDailyStatus)
      .set({ status: 'INELIGIBLE', reason: 'test: nobody eligible' })
      .where(eq(schema.repDailyStatus.businessDate, bDate))

    try {
      const queued = await assignOne('Queued Lead', '9110008')
      expect(queued.assignedRepId).toBeNull()

      const result = await voidLead(db, {
        leadId: queued.leadId,
        reasonNote: 'undo queued',
        actorUserId: bdcUserId,
      })
      expect(result.repId).toBeNull()

      const lead = await db.query.lead.findFirst({ where: eq(schema.lead.id, queued.leadId) })
      expect(lead?.status).toBe('VOID')

      const queueRow = await db.query.unassignedQueue.findFirst({
        where: eq(schema.unassignedQueue.leadId, queued.leadId),
      })
      expect(queueRow?.resolvedAt).toBeTruthy()
    } finally {
      await db
        .update(schema.repDailyStatus)
        .set({ status: 'ELIGIBLE', reason: null })
        .where(eq(schema.repDailyStatus.businessDate, bDate))
    }
  })
})

async function lastAssignCycle(leadId: string): Promise<string | null> {
  const event = await db.query.assignmentEvents.findFirst({
    where: and(eq(schema.assignmentEvents.leadId, leadId), eq(schema.assignmentEvents.eventType, 'ASSIGN')),
  })
  return event?.cycleNo ?? null
}
