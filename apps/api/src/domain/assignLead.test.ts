import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, schema } from '@phoneup/db'
import { assignLead } from './assignLead'

let repIds: string[] = []
let bdcUserId: string

beforeAll(async () => {
  const reps = await db.select().from(schema.salesRep)
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
})
