import { describe, it, expect, beforeAll } from 'vitest'
import { isNull } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { db, schema } from '@phoneup/db'
import { businessDate, periodKey } from '@phoneup/core'
import { reconcile } from './reconciliation'

const today = businessDate(new Date())

async function createLeadFor(repId: string, pKey: string) {
  const [customer] = await db
    .insert(schema.customer)
    .values({ fullName: 'Recon Test Customer', phoneE164: `+1555${randomUUID().replace(/\D/g, '').slice(0, 7)}` })
    .returning()
  const [lead] = await db
    .insert(schema.lead)
    .values({
      customerId: customer.id,
      assignedRepId: repId,
      status: 'ASSIGNED',
      businessDate: today,
      periodKey: pKey,
      createdBy: repId,
    })
    .returning()
  return lead.id
}

describe('reconcile', () => {
  let repId: string
  let cycleId: string
  const pKey = periodKey(today)

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.appUser)
      .values({ email: `recon-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    const [rep] = await db
      .insert(schema.salesRep)
      .values({ userId: user.id, displayName: 'Recon Rep', hireDate: '2020-01-01' })
      .returning()
    repId = rep.id
    const openCycle = await db.query.rotationCycle.findFirst({ where: isNull(schema.rotationCycle.closedAt) })
    cycleId = openCycle!.id
  })

  it('flags a mismatch when the counter is drifted from the ledger', async () => {
    // two ASSIGN ledger events for this rep this period...
    for (let i = 0; i < 2; i++) {
      const leadId = await createLeadFor(repId, pKey)
      await db.insert(schema.assignmentEvents).values({
        leadId,
        repId,
        eventType: 'ASSIGN',
        cycleNo: cycleId,
        creditDelta: 1,
        queueSnapshot: [],
        idempotencyKey: randomUUID(),
      })
    }
    // ...but the counter drifted to only 1
    await db.insert(schema.repMonthCounters).values({ repId, periodKey: pKey, upsMtd: 1 })

    const result = await reconcile(db)
    const mismatch = result.mismatches.find((m) => m.repId === repId && m.periodKey === pKey)
    expect(mismatch).toBeDefined()
    expect(mismatch?.expected).toBe(2)
    expect(mismatch?.actual).toBe(1)
  })

  it('reports no mismatch when ledger and counters agree', async () => {
    const [user] = await db
      .insert(schema.appUser)
      .values({ email: `recon-clean-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    const [rep] = await db
      .insert(schema.salesRep)
      .values({ userId: user.id, displayName: 'Clean Rep', hireDate: '2020-01-01' })
      .returning()
    const leadId = await createLeadFor(rep.id, pKey)
    await db.insert(schema.assignmentEvents).values({
      leadId,
      repId: rep.id,
      eventType: 'ASSIGN',
      cycleNo: cycleId,
      creditDelta: 1,
      queueSnapshot: [],
      idempotencyKey: randomUUID(),
    })
    await db.insert(schema.repMonthCounters).values({ repId: rep.id, periodKey: pKey, upsMtd: 1 })

    const result = await reconcile(db)
    const mismatch = result.mismatches.find((m) => m.repId === rep.id && m.periodKey === pKey)
    expect(mismatch).toBeUndefined()
  })
})
