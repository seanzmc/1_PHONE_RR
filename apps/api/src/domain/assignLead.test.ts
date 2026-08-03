import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq, isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, schema } from '@phoneup/db'
import { businessDate, periodKey } from '@phoneup/core'
import { assignLead } from './assignLead'
import { selectActiveReps } from './activeReps'

let repIds: string[] = []
let bdcUserId: string

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
    const bDate = businessDate(new Date())
    const pKey = periodKey(bDate)
    const cycleRepIds = repIds.slice(0, 3)
    const statusRows = await db.query.repDailyStatus.findMany({
      where: eq(schema.repDailyStatus.businessDate, bDate),
    })
    const suppressed = statusRows.filter((row: any) =>
      repIds.includes(row.repId) && !cycleRepIds.includes(row.repId) && row.status === 'ELIGIBLE',
    )

    // Keep this integration test bounded to three active reps, then restore the
    // shared fixture exactly as it was.
    for (const row of suppressed) {
      await db.update(schema.repDailyStatus).set({ status: 'INELIGIBLE', reason: 'test fixture' })
        .where(eq(schema.repDailyStatus.id, row.id))
    }

    try {
      // Deliberately uneven totals make this fail if a new cycle falls back to monthly load.
      for (const [index, repId] of cycleRepIds.entries()) {
        await db.insert(schema.repMonthCounters).values({
          repId,
          periodKey: pKey,
          upsMtd: (index + 1) * 10,
        })
      }

      const servedOrder = [...cycleRepIds].reverse()
      for (const [index, repId] of servedOrder.entries()) {
        await assignLead(db, {
          idempotencyKey: randomUUID(),
          customerName: `Cycle one ${index}`,
          customerPhoneE164: `+1555888${String(1000 + index).padStart(4, '0')}`,
          forcedRepId: repId,
          actorUserId: bdcUserId,
        })
      }

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
    } finally {
      for (const row of suppressed) {
        await db.update(schema.repDailyStatus).set({ status: row.status, reason: row.reason })
          .where(eq(schema.repDailyStatus.id, row.id))
      }
    }
  }, 20_000)
})
