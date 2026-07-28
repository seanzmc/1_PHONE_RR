import { describe, it, expect, beforeAll } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { evaluateRepEligibility } from './eligibility'

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

describe('evaluateRepEligibility', () => {
  let repId: string
  let policyId: string
  const yesterday = addDays(new Date().toISOString().slice(0, 10), -1)
  const today = new Date().toISOString().slice(0, 10)

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.appUser)
      .values({ email: `elig-test-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    const [rep] = await db
      .insert(schema.salesRep)
      .values({ userId: user.id, displayName: 'Eligibility Test Rep', hireDate: '2020-01-01' })
      .returning()
    repId = rep.id

    const [policy] = await db
      .insert(schema.workRequirementPolicy)
      .values({ minCalls: 3, enforcementMode: 'SHADOW' })
      .returning()
    policyId = policy.id

    await db.insert(schema.repShift).values({ repId, businessDate: yesterday, kind: 'WORK' })
    await db.insert(schema.repShift).values({ repId, businessDate: today, kind: 'WORK' })

    // mark the CRM import as "done" for yesterday (some other rep's activity landed),
    // so the eligibility job doesn't treat the whole day as IMPORT_LATE — our test rep
    // still has zero activity rows of their own, which is what we're evaluating.
    const [otherUser] = await db
      .insert(schema.appUser)
      .values({ email: `elig-other-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    const [otherRep] = await db
      .insert(schema.salesRep)
      .values({ userId: otherUser.id, displayName: 'Other Rep', hireDate: '2020-01-01' })
      .returning()
    await db.insert(schema.leadActivity).values({
      repId: otherRep.id,
      occurredAt: new Date(`${yesterday}T12:00:00Z`),
      businessDate: yesterday,
      entrySource: 'CRM_IMPORT',
    })
  })

  it('SHADOW mode: computes would-be INELIGIBLE on low calls but resolves status stays ELIGIBLE', async () => {
    // import landed for the day (see beforeAll), but this rep has 0 calls of their own -> below min_calls=3
    await evaluateRepEligibility(db, { repId, businessDate: today, policyId })

    const snapshot = await db.query.eligibilitySnapshot.findFirst({
      where: and(eq(schema.eligibilitySnapshot.repId, repId), eq(schema.eligibilitySnapshot.businessDate, today)),
    })
    expect(snapshot?.wouldBeStatus).toBe('INELIGIBLE')

    const status = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(status?.status).toBe('ELIGIBLE')
  })

  it('fail-safe: no rep_shift row for today -> CONFIGURATION_ERROR, never silently ELIGIBLE', async () => {
    const [user] = await db
      .insert(schema.appUser)
      .values({ email: `elig-noshift-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    const [repNoShift] = await db
      .insert(schema.salesRep)
      .values({ userId: user.id, displayName: 'No Shift Rep', hireDate: '2020-01-01' })
      .returning()

    await evaluateRepEligibility(db, { repId: repNoShift.id, businessDate: today, policyId })

    const status = await db.query.repDailyStatus.findFirst({
      where: and(
        eq(schema.repDailyStatus.repId, repNoShift.id),
        eq(schema.repDailyStatus.businessDate, today),
      ),
    })
    expect(status?.status).toBe('CONFIGURATION_ERROR')
  })

  it('override always wins: existing manager override is not overwritten by the job', async () => {
    // simulate an existing manager override for today (job already ran once in the prior test)
    await db
      .update(schema.repDailyStatus)
      .set({ status: 'INELIGIBLE', decidedBy: 'MANAGER_OVERRIDE', reason: 'manager forced inactive' })
      .where(and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)))

    await evaluateRepEligibility(db, { repId, businessDate: today, policyId })

    const status = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(status?.decidedBy).toBe('MANAGER_OVERRIDE')
    expect(status?.status).toBe('INELIGIBLE')
  })
})
