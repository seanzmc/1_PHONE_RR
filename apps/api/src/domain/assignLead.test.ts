import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, schema } from '@phoneup/db'
import { businessDate, periodKey } from '@phoneup/core'
import { assignLead } from './assignLead'
import { selectActiveReps } from './activeReps'
import { t } from '../trpc/router'
import { boardRouter } from '../routers/board'
import type { Context } from '../trpc/context'

let repIds: string[] = []
let bdcUserId: string

/** `board.roster` is session-gated, so reach it through a caller the way board.test.ts does. */
function boardCaller() {
  return t.createCallerFactory(boardRouter)({
    session: { userId: 'assign-test-manager', role: 'MANAGER', mustChangePassword: false, sessionId: 'assign-test' },
    req: {} as Context['req'],
    res: {} as Context['res'],
  })
}

/**
 * Bound an integration test to `activeRepIds`, then restore the shared fixture exactly as
 * it was. Every other rep is parked INELIGIBLE for the day, which keeps a rotation
 * assertion readable without depending on how many reps the seed happens to create.
 */
async function withOnlyRepsEligible<T>(activeRepIds: string[], run: () => Promise<T>): Promise<T> {
  const bDate = businessDate(new Date())
  const statusRows = await db.query.repDailyStatus.findMany({
    where: eq(schema.repDailyStatus.businessDate, bDate),
  })
  const suppressed = statusRows.filter((row: any) =>
    repIds.includes(row.repId) && !activeRepIds.includes(row.repId) && row.status === 'ELIGIBLE',
  )
  for (const row of suppressed) {
    await db.update(schema.repDailyStatus).set({ status: 'INELIGIBLE', reason: 'test fixture' })
      .where(eq(schema.repDailyStatus.id, row.id))
  }
  try {
    return await run()
  } finally {
    for (const row of suppressed) {
      await db.update(schema.repDailyStatus).set({ status: row.status, reason: row.reason })
        .where(eq(schema.repDailyStatus.id, row.id))
    }
  }
}

/** Uneven monthly totals, so any fallback to monthly load shows up as a different order. */
async function seedUnevenMonthlyLoad(orderedRepIds: string[]): Promise<void> {
  const pKey = periodKey(businessDate(new Date()))
  for (const [index, repId] of orderedRepIds.entries()) {
    await db.insert(schema.repMonthCounters).values({ repId, periodKey: pKey, upsMtd: (index + 1) * 10 })
  }
}

/** Run one full cycle in `servedOrder`, forcing each rep so the order is the test's choice. */
async function runCycle(servedOrder: string[], label: string, phonePrefix: string): Promise<void> {
  for (const [index, repId] of servedOrder.entries()) {
    await assignLead(db, {
      idempotencyKey: randomUUID(),
      customerName: `${label} ${index}`,
      customerPhoneE164: `${phonePrefix}${String(1000 + index).padStart(4, '0')}`,
      forcedRepId: repId,
      actorUserId: bdcUserId,
    })
  }
}

beforeAll(async () => {
  const reps = await selectActiveReps(db)
  repIds = reps.map((r: any) => r.id)
  const bdc = await db.query.appUser.findFirst({ where: eq(schema.appUser.role, 'BDC') })
  bdcUserId = bdc!.id
})

beforeEach(async () => {
  // reset ledger/counters/leads for a clean slate each test, keep reps/status/cycle rows
  await db.delete(schema.assignmentEvents)
  await db.delete(schema.rrCycleAssignments)
  await db.delete(schema.unassignedQueue)
  await db.delete(schema.lead)
  await db.delete(schema.customer)
  await db.delete(schema.repMonthCounters)
})

describe('assignLead', () => {
  it('assigns to an eligible rep and writes ledger+counter atomically', async () => {
    const result = await assignLead(db, {
      idempotencyKey: randomUUID(),
      customerName: 'Jane Doe',
      customerPhoneE164: '+15551230001',
      actorUserId: bdcUserId,
    })
    expect(result.assignedRepId).toBeTruthy()
    expect(repIds).toContain(result.assignedRepId)
    expect(result.customerName).toBe('Jane Doe')
    expect(new Date(result.assignedAt).toString()).not.toBe('Invalid Date')

    const events = await db
      .select()
      .from(schema.assignmentEvents)
      .where(eq(schema.assignmentEvents.leadId, result.leadId))
    expect(events.some((e: any) => e.eventType === 'ASSIGN')).toBe(true)

    const counter = await db.query.repMonthCounters.findFirst({
      where: eq(schema.repMonthCounters.repId, result.assignedRepId!),
    })
    expect(counter?.upsMtd).toBe(1)
  })

  it('is exactly-once under retry with the same idempotency key', async () => {
    const key = randomUUID()
    const first = await assignLead(db, {
      idempotencyKey: key,
      customerName: 'Retry Customer',
      customerPhoneE164: '+15551230002',
      actorUserId: bdcUserId,
    })
    const second = await assignLead(db, {
      idempotencyKey: key,
      customerName: 'Retry Customer',
      customerPhoneE164: '+15551230002',
      actorUserId: bdcUserId,
    })
    expect(second.leadId).toBe(first.leadId)
    expect(second.assignedRepId).toBe(first.assignedRepId)
  })

  it('warns but does not block on a duplicate phone number', async () => {
    const first = await assignLead(db, {
      idempotencyKey: randomUUID(),
      customerName: 'Dup A',
      customerPhoneE164: '+15551230003',
      actorUserId: bdcUserId,
    })
    const second = await assignLead(db, {
      idempotencyKey: randomUUID(),
      customerName: 'Dup A Again',
      customerPhoneE164: '+15551230003',
      actorUserId: bdcUserId,
    })
    expect(second.duplicatePhone).toBe(true)
    expect(second.leadId).not.toBe(first.leadId)
  })

  it('starts the next cycle in the order reps entered Served This Round', async () => {
    const cycleRepIds = repIds.slice(0, 3)
    await withOnlyRepsEligible(cycleRepIds, async () => {
      await seedUnevenMonthlyLoad(cycleRepIds)
      const servedOrder = [...cycleRepIds].reverse()
      await runCycle(servedOrder, 'Cycle one', '+1555888')

      const openCycle = await db.query.rotationCycle.findFirst({
        where: isNull(schema.rotationCycle.closedAt),
      })
      expect(openCycle).toBeTruthy()

      const nextCycleOrder: string[] = []
      for (const index of servedOrder.keys()) {
        const result = await assignLead(db, {
          idempotencyKey: randomUUID(),
          customerName: `Cycle two ${index}`,
          customerPhoneE164: `+1555999${String(1000 + index).padStart(4, '0')}`,
          actorUserId: bdcUserId,
        })
        nextCycleOrder.push(result.assignedRepId!)
      }

      expect(nextCycleOrder).toEqual(servedOrder)
    })
  }, 20_000)

  // The board is where a rep is told they are next. If it ranks on different inputs than
  // assignLead, it names someone the lead will not go to — the exact "why wasn't I next"
  // question the ledger exists to answer.
  it('names the same next rep on the board that the next lead is assigned to', async () => {
    const cycleRepIds = repIds.slice(0, 3)
    await withOnlyRepsEligible(cycleRepIds, async () => {
      await seedUnevenMonthlyLoad(cycleRepIds)
      const servedOrder = [...cycleRepIds].reverse()
      await runCycle(servedOrder, 'Board cycle one', '+1555777')

      const roster = await boardCaller().roster()
      const boardNextUp = roster.find((row: any) => row.isEligible && !row.servedThisCycle)

      const result = await assignLead(db, {
        idempotencyKey: randomUUID(),
        customerName: 'Board cycle two',
        customerPhoneE164: '+15557760001',
        actorUserId: bdcUserId,
      })

      expect(boardNextUp?.repId).toBe(result.assignedRepId)
      expect(result.assignedRepId).toBe(servedOrder[0])
    })
  }, 20_000)

  // A rep parked INELIGIBLE for a whole cycle has no slot in it. Ranking them behind
  // everyone who does would be permanent: the next cycle records them last again, and
  // monthly load can no longer pull them back once prior-cycle order outranks it.
  it('puts a rep who sat out the whole cycle next up, not last', async () => {
    // Two reps run the cycle, a third sits it out — the seed guarantees three.
    const cycleRepIds = repIds.slice(0, 2)
    const satOutRepId = repIds[2]
    expect(satOutRepId).toBeTruthy()

    await withOnlyRepsEligible(cycleRepIds, async () => {
      await seedUnevenMonthlyLoad(cycleRepIds)
      const servedOrder = [...cycleRepIds].reverse()
      await runCycle(servedOrder, 'Sat out cycle one', '+1555666')

      // Manager reactivates them the next day; the sat-out rep now takes the next turn.
      const satOutStatus = await db.query.repDailyStatus.findFirst({
        where: and(
          eq(schema.repDailyStatus.repId, satOutRepId),
          eq(schema.repDailyStatus.businessDate, businessDate(new Date())),
        ),
      })
      expect(satOutStatus).toBeTruthy()
      await db.update(schema.repDailyStatus)
        .set({ status: 'ELIGIBLE', reason: null })
        .where(eq(schema.repDailyStatus.id, satOutStatus!.id))

      try {
        const result = await assignLead(db, {
          idempotencyKey: randomUUID(),
          customerName: 'Sat out cycle two',
          customerPhoneE164: '+15556650001',
          actorUserId: bdcUserId,
        })

        expect(result.assignedRepId).toBe(satOutRepId)
      } finally {
        await db.update(schema.repDailyStatus)
          .set({ status: satOutStatus!.status, reason: satOutStatus!.reason })
          .where(eq(schema.repDailyStatus.id, satOutStatus!.id))
      }
    })
  }, 20_000)
})
