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
  await db.delete(schema.assignmentEvents)
  await db.delete(schema.rrCycleAssignments)
  await db.delete(schema.unassignedQueue)
  await db.delete(schema.lead)
  await db.delete(schema.customer)
  await db.delete(schema.repMonthCounters)
})

describe('assignLead concurrency', () => {
  it('serves reps round-robin under 10 parallel submissions, no double-serve within a cycle', async () => {
    const N = 10
    const calls = Array.from({ length: N }, (_, i) =>
      assignLead(db, {
        idempotencyKey: randomUUID(),
        customerName: `Concurrent Customer ${i}`,
        customerPhoneE164: `+1555777${String(1000 + i).padStart(4, '0')}`,
        actorUserId: bdcUserId,
      }),
    )
    const results = await Promise.all(calls)
    expect(results.every((r) => r.assignedRepId)).toBe(true)

    const counters = await db.query.repMonthCounters.findMany()
    const total = counters.reduce((sum: number, c: any) => sum + c.upsMtd, 0)
    expect(total).toBe(N)

    const events = await db.query.assignmentEvents.findMany({
      where: eq(schema.assignmentEvents.eventType, 'ASSIGN'),
    })
    expect(events.length).toBe(N)

    // no rep should be served twice before every eligible rep has been served once,
    // i.e. within any prefix of N/reps.length consecutive assigns per rep, load stays balanced
    const maxLoad = Math.max(...counters.map((c: any) => c.upsMtd))
    const minLoad = Math.min(...counters.map((c: any) => c.upsMtd))
    expect(maxLoad - minLoad).toBeLessThanOrEqual(1)
  })

  it('is exactly-once under a burst of retries sharing one idempotency key', async () => {
    const key = randomUUID()
    const calls = Array.from({ length: 5 }, () =>
      assignLead(db, {
        idempotencyKey: key,
        customerName: 'Retry Burst',
        customerPhoneE164: '+15559998888',
        actorUserId: bdcUserId,
      }),
    )
    const results = await Promise.all(calls)
    const leadIds = new Set(results.map((r) => r.leadId))
    expect(leadIds.size).toBe(1)

    const events = await db.query.assignmentEvents.findMany({
      where: eq(schema.assignmentEvents.idempotencyKey, key),
    })
    expect(events.length).toBe(1)
  })
})
