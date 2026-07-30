import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq, and, inArray } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import {
  businessDatesThroughSaturday,
  dayOfWeek,
  evaluateRepEligibility,
  materializeShifts,
  shiftDate,
} from './eligibility'
import { setRecurringDaysOff } from '../domain/daysOff'
import { overrideStatus } from '../domain/overrideStatus'

// Fixed reference WEEK SHAPE so assertions never depend on when the suite runs, but
// anchored on a per-run unique Monday: this suite shares one live Postgres DB with every
// other test file and with its own previous runs, and the IMPORT_LATE check is global
// ("does ANY rep have a row for that date"). A per-run week keeps runs from colliding.
// 2026-07-27 is a Monday; adding whole weeks preserves every weekday alignment.
const WEEK_OFFSET_DAYS = 7 * (1 + (Date.now() % 2000))
const MONDAY = shiftDate('2026-07-27', WEEK_OFFSET_DAYS)
const TUESDAY = shiftDate(MONDAY, 1)
const WEDNESDAY = shiftDate(MONDAY, 2)
const THURSDAY = shiftDate(MONDAY, 3)
const FRIDAY = shiftDate(MONDAY, 4)
const SATURDAY = shiftDate(MONDAY, 5)
const SUNDAY = shiftDate(MONDAY, 6)
const NEXT_MONDAY = shiftDate(MONDAY, 7)

let repId: string
let otherRepId: string
let enforcePolicyId: string
let shadowPolicyId: string
let managerUserId: string

async function makeRep(displayName: string): Promise<string> {
  const [user] = await db
    .insert(schema.appUser)
    .values({
      email: `elig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@dealership.test`,
      passwordHash: 'x:y',
      role: 'REP',
    })
    .returning()
  const [rep] = await db
    .insert(schema.salesRep)
    .values({ userId: user.id, displayName, hireDate: '2020-01-01' })
    .returning()
  return rep.id
}

/** Give a rep WORK shifts for the whole reference week (Sunday stays OFF). */
async function seedWorkWeek(id: string) {
  for (const date of [MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, NEXT_MONDAY]) {
    await db.insert(schema.repShift).values({ repId: id, businessDate: date, kind: 'WORK' })
  }
  await db.insert(schema.repShift).values({ repId: id, businessDate: SUNDAY, kind: 'OFF' })
}

async function setCalls(id: string, date: string, calls: number) {
  await db
    .insert(schema.repDailyActivity)
    .values({ repId: id, businessDate: date, calls, sold: 0, source: 'IMPORT' })
    .onConflictDoUpdate({
      target: [schema.repDailyActivity.repId, schema.repDailyActivity.businessDate],
      set: { calls },
    })
}

async function statusOn(id: string, date: string) {
  return db.query.repDailyStatus.findFirst({
    where: and(eq(schema.repDailyStatus.repId, id), eq(schema.repDailyStatus.businessDate, date)),
  })
}

beforeAll(async () => {
  const manager = await db.query.appUser.findFirst({ where: eq(schema.appUser.role, 'ADMIN') })
  managerUserId = manager!.id

  repId = await makeRep(`Week DQ Rep ${Date.now()}`)
  otherRepId = await makeRep(`Week DQ Other ${Date.now()}`)

  const [enforce] = await db
    .insert(schema.workRequirementPolicy)
    .values({ minCalls: 10, enforcementMode: 'ENFORCE', maxPriorWorkdayAge: 7 })
    .returning()
  enforcePolicyId = enforce.id

  const [shadow] = await db
    .insert(schema.workRequirementPolicy)
    .values({ minCalls: 10, enforcementMode: 'SHADOW', maxPriorWorkdayAge: 7 })
    .returning()
  shadowPolicyId = shadow.id
})

beforeEach(async () => {
  const ids = [repId, otherRepId]
  await db.delete(schema.repDailyStatus).where(inArray(schema.repDailyStatus.repId, ids))
  await db.delete(schema.eligibilitySnapshot).where(inArray(schema.eligibilitySnapshot.repId, ids))
  await db.delete(schema.repDailyActivity).where(inArray(schema.repDailyActivity.repId, ids))
  await db.delete(schema.repShift).where(inArray(schema.repShift.repId, ids))
  await db.delete(schema.repRecurringDayOff).where(inArray(schema.repRecurringDayOff.repId, ids))
  await seedWorkWeek(repId)
  await seedWorkWeek(otherRepId)
})

describe('business week helpers', () => {
  it('Sunday is never a business date', () => {
    expect(dayOfWeek(SUNDAY)).toBe(0)
    expect(businessDatesThroughSaturday(SUNDAY)).not.toContain(SUNDAY)
  })

  it('a DQ computed on Monday covers Mon–Sat', () => {
    expect(businessDatesThroughSaturday(MONDAY)).toEqual([
      MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY,
    ])
  })

  it('a DQ computed on Saturday covers exactly one day', () => {
    expect(businessDatesThroughSaturday(SATURDAY)).toEqual([SATURDAY])
  })

  it('never crosses into next week, so Monday re-evaluates clean with no reset job', () => {
    const dates = businessDatesThroughSaturday(TUESDAY)
    expect(dates).toEqual([TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY])
    expect(dates).not.toContain(NEXT_MONDAY)
    expect(dates).not.toContain(SUNDAY)
  })
})

describe('week suspension (ENFORCE)', () => {
  it('under-minimum on the prior workday writes INELIGIBLE Tue–Sat, and Monday stays clean', async () => {
    await setCalls(repId, MONDAY, 4) // below minCalls=10
    await setCalls(otherRepId, MONDAY, 12) // the import landed for the day

    await evaluateRepEligibility(db, { repId, businessDate: TUESDAY, policyId: enforcePolicyId })

    for (const date of [TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY]) {
      const status = await statusOn(repId, date)
      expect(status?.status, `expected INELIGIBLE on ${date}`).toBe('INELIGIBLE')
      expect(status?.reason).toContain('WEEK_DQ')
      expect(status?.reason).toContain('4 calls')
      // future rows are SYSTEM-decided so a manager reactivation still wins later
      expect(status?.decidedBy).toBe('SYSTEM')
    }

    // never crosses the week boundary — no reset job needed
    expect(await statusOn(repId, SUNDAY)).toBeUndefined()
    expect(await statusOn(repId, NEXT_MONDAY)).toBeUndefined()
  })

  it('a DQ evaluated on Saturday writes exactly one day', async () => {
    await setCalls(repId, FRIDAY, 1)
    await setCalls(otherRepId, FRIDAY, 12)

    await evaluateRepEligibility(db, { repId, businessDate: SATURDAY, policyId: enforcePolicyId })

    expect((await statusOn(repId, SATURDAY))?.status).toBe('INELIGIBLE')
    expect(await statusOn(repId, SUNDAY)).toBeUndefined()
    expect(await statusOn(repId, NEXT_MONDAY)).toBeUndefined()
  })

  it('meeting the minimum leaves the rep ELIGIBLE with no tail written', async () => {
    await setCalls(repId, MONDAY, 10) // exactly the minimum qualifies
    await evaluateRepEligibility(db, { repId, businessDate: TUESDAY, policyId: enforcePolicyId })

    expect((await statusOn(repId, TUESDAY))?.status).toBe('ELIGIBLE')
    expect(await statusOn(repId, WEDNESDAY)).toBeUndefined()
  })

  it('carry-forward: a rep off Wednesday is judged Thursday on TUESDAY\'s calls', async () => {
    // the worked example from the notes — no algorithm change, the shift rows just have to exist
    await db
      .update(schema.repShift)
      .set({ kind: 'OFF' })
      .where(and(eq(schema.repShift.repId, repId), eq(schema.repShift.businessDate, WEDNESDAY)))

    await setCalls(repId, TUESDAY, 10) // qualified on their last worked day
    await setCalls(repId, WEDNESDAY, 0) // registers 0 on their day off
    await setCalls(otherRepId, WEDNESDAY, 5)

    await evaluateRepEligibility(db, { repId, businessDate: THURSDAY, policyId: enforcePolicyId })

    const snapshot = await db.query.eligibilitySnapshot.findFirst({
      where: and(
        eq(schema.eligibilitySnapshot.repId, repId),
        eq(schema.eligibilitySnapshot.businessDate, THURSDAY),
      ),
    })
    expect(snapshot?.evaluatedPriorWorkday).toBe(TUESDAY) // NOT Wednesday
    expect(snapshot?.callsFound).toBe(10)
    expect((await statusOn(repId, THURSDAY))?.status).toBe('ELIGIBLE')
  })

  it('a day off inside a suspension stays ineligible without losing the DQ reason', async () => {
    await setCalls(repId, MONDAY, 2)
    await setCalls(otherRepId, MONDAY, 12)
    await evaluateRepEligibility(db, { repId, businessDate: TUESDAY, policyId: enforcePolicyId })
    expect((await statusOn(repId, WEDNESDAY))?.reason).toContain('WEEK_DQ')

    // now Wednesday becomes a day off and the day is re-evaluated
    await db
      .update(schema.repShift)
      .set({ kind: 'OFF' })
      .where(and(eq(schema.repShift.repId, repId), eq(schema.repShift.businessDate, WEDNESDAY)))
    await evaluateRepEligibility(db, { repId, businessDate: WEDNESDAY, policyId: enforcePolicyId })

    const status = await statusOn(repId, WEDNESDAY)
    expect(status?.status).toBe('INELIGIBLE')
    expect(status?.reason).toContain('off') // day-off reason surfaces...
    expect(status?.reason).toContain('WEEK_DQ') // ...without dropping the DQ
  })

  it('never auto-DQs when the import for the prior workday has not landed (IMPORT_LATE)', async () => {
    // nobody at all has a rep_daily_activity row for Monday
    await evaluateRepEligibility(db, { repId, businessDate: TUESDAY, policyId: enforcePolicyId })

    const status = await statusOn(repId, TUESDAY)
    expect(status?.status).toBe('ELIGIBLE')
    expect(status?.reason).toContain('IMPORT_LATE')
  })

  it('a roster rep absent from the import is judged on 0 calls, not exempted', async () => {
    await setCalls(otherRepId, MONDAY, 12) // import landed, but our rep has no row
    await evaluateRepEligibility(db, { repId, businessDate: TUESDAY, policyId: enforcePolicyId })

    const snapshot = await db.query.eligibilitySnapshot.findFirst({
      where: and(
        eq(schema.eligibilitySnapshot.repId, repId),
        eq(schema.eligibilitySnapshot.businessDate, TUESDAY),
      ),
    })
    expect(snapshot?.callsFound).toBe(0)
    expect((await statusOn(repId, TUESDAY))?.status).toBe('INELIGIBLE')
  })
})

describe('SHADOW mode', () => {
  it('writes the snapshot and a SHADOW log line but never an INELIGIBLE status', async () => {
    await setCalls(repId, MONDAY, 1)
    await setCalls(otherRepId, MONDAY, 12)

    await evaluateRepEligibility(db, { repId, businessDate: TUESDAY, policyId: shadowPolicyId })

    const snapshot = await db.query.eligibilitySnapshot.findFirst({
      where: and(
        eq(schema.eligibilitySnapshot.repId, repId),
        eq(schema.eligibilitySnapshot.businessDate, TUESDAY),
      ),
    })
    expect(snapshot?.wouldBeStatus).toBe('INELIGIBLE') // computed...

    const status = await statusOn(repId, TUESDAY)
    expect(status?.status).toBe('ELIGIBLE') // ...but enforced on nobody
    expect(status?.reason).toContain('SHADOW')

    // and no tail was written for the rest of the week
    expect(await statusOn(repId, WEDNESDAY)).toBeUndefined()
  })
})

describe('manual reactivation vs the week tail', () => {
  it('FORCE_ACTIVE clears the remaining WEEK_DQ rows so the rep is not re-DQd tomorrow', async () => {
    // Build a suspension anchored on today, because overrideStatus operates on the real today.
    const { businessDate } = await import('@phoneup/core')
    const today = businessDate(new Date())
    const week = businessDatesThroughSaturday(today)

    for (const date of week) {
      await db
        .insert(schema.repDailyStatus)
        .values({
          repId,
          businessDate: date,
          status: 'INELIGIBLE',
          reason: 'WEEK_DQ: 3 calls on prior workday, 10 required',
          decidedBy: 'SYSTEM',
        })
        .onConflictDoNothing()
    }

    await overrideStatus(db, {
      repId,
      status: 'FORCE_ACTIVE',
      reasonCode: 'FORCE_ACTIVE',
      reasonNote: 'manager verified calls were logged in the wrong CRM user',
      actorUserId: managerUserId,
    })

    expect((await statusOn(repId, today))?.status).toBe('ELIGIBLE')
    expect((await statusOn(repId, today))?.decidedBy).toBe('MANAGER_OVERRIDE')

    // the tail is gone — no silent re-DQ tomorrow
    for (const date of week.filter((d) => d !== today)) {
      const status = await statusOn(repId, date)
      expect(status === undefined || status.status !== 'INELIGIBLE', `tail remained on ${date}`).toBe(true)
    }
  })

  it('FORCE_INACTIVE writes through the end of the business week', async () => {
    const { businessDate } = await import('@phoneup/core')
    const today = businessDate(new Date())

    await overrideStatus(db, {
      repId,
      status: 'FORCE_INACTIVE',
      reasonCode: 'FORCE_INACTIVE',
      reasonNote: 'suspended pending review',
      actorUserId: managerUserId,
    })

    for (const date of businessDatesThroughSaturday(today)) {
      const status = await statusOn(repId, date)
      expect(status?.status, `expected INELIGIBLE on ${date}`).toBe('INELIGIBLE')
      expect(status?.decidedBy).toBe('MANAGER_OVERRIDE')
    }
  })

  it('a reactivated rep is STILL subject to the daily qualifier the next morning', async () => {
    // reactivation only clears status rows; it never marks a rep exempt. This is the
    // easiest requirement to break by adding an "exempt" flag, so assert it directly.
    await db.insert(schema.repDailyStatus).values({
      repId,
      businessDate: MONDAY,
      status: 'ELIGIBLE',
      reason: 'manager reactivated',
      decidedBy: 'MANAGER_OVERRIDE',
    })

    await setCalls(repId, MONDAY, 3) // still under the minimum on the day they worked
    await setCalls(otherRepId, MONDAY, 12)

    await evaluateRepEligibility(db, { repId, businessDate: TUESDAY, policyId: enforcePolicyId })

    // Monday's override is untouched, but Tuesday re-DQs on the numbers
    expect((await statusOn(repId, MONDAY))?.status).toBe('ELIGIBLE')
    expect((await statusOn(repId, TUESDAY))?.status).toBe('INELIGIBLE')
    expect((await statusOn(repId, TUESDAY))?.reason).toContain('WEEK_DQ')
  })
})

describe('materializeShifts + recurring days off', () => {
  it('generates WORK/OFF rows ahead, with Sunday always OFF', async () => {
    await db.delete(schema.repShift).where(eq(schema.repShift.repId, repId))

    await materializeShifts(db, { fromDate: MONDAY, days: 14, repIds: [repId] })

    const rows = await db.query.repShift.findMany({ where: eq(schema.repShift.repId, repId) })
    expect(rows.length).toBe(14)

    const byDate = new Map(rows.map((r: any) => [r.businessDate, r.kind]))
    expect(byDate.get(MONDAY)).toBe('WORK')
    expect(byDate.get(SATURDAY)).toBe('WORK')
    expect(byDate.get(SUNDAY)).toBe('OFF') // hardcoded, no config surface
  })

  it('a recurring day off becomes OFF and does NOT consume a Sunday entry', async () => {
    await db.delete(schema.repShift).where(eq(schema.repShift.repId, repId))

    // 3 = Wednesday
    await setRecurringDaysOff(db, { repId, daysOfWeek: [0, 3], actorUserId: managerUserId })

    // Sunday (0) is dropped server-side — the store is closed, it needs no rep-level entry
    const stored = await db.query.repRecurringDayOff.findMany({
      where: eq(schema.repRecurringDayOff.repId, repId),
    })
    expect(stored.map((r: any) => r.dayOfWeek)).toEqual([3])

    await materializeShifts(db, { fromDate: MONDAY, days: 7, repIds: [repId] })
    const rows = await db.query.repShift.findMany({ where: eq(schema.repShift.repId, repId) })
    const byDate = new Map(rows.map((r: any) => [r.businessDate, r.kind]))
    expect(byDate.get(WEDNESDAY)).toBe('OFF')
    expect(byDate.get(THURSDAY)).toBe('WORK')
  })

  it('never overwrites a manually-set PTO/SICK/TRAINING row', async () => {
    await db.delete(schema.repShift).where(eq(schema.repShift.repId, repId))
    await db.insert(schema.repShift).values({ repId, businessDate: THURSDAY, kind: 'PTO' })

    await materializeShifts(db, { fromDate: MONDAY, days: 14, repIds: [repId] })

    const row = await db.query.repShift.findFirst({
      where: and(eq(schema.repShift.repId, repId), eq(schema.repShift.businessDate, THURSDAY)),
    })
    expect(row?.kind).toBe('PTO') // the manager's decision wins over the generator
  })

  it('re-materializing after a days-off change never rewrites a PAST date', async () => {
    const { businessDate } = await import('@phoneup/core')
    const today = businessDate(new Date())
    const pastDate = shiftDate(today, -3)

    await db.delete(schema.repShift).where(eq(schema.repShift.repId, repId))
    await db.insert(schema.repShift).values({ repId, businessDate: pastDate, kind: 'WORK' })

    // set every weekday off — if the generator reached backwards, the past row would flip to OFF
    await setRecurringDaysOff(db, { repId, daysOfWeek: [1, 2, 3, 4, 5, 6], actorUserId: managerUserId })

    const past = await db.query.repShift.findFirst({
      where: and(eq(schema.repShift.repId, repId), eq(schema.repShift.businessDate, pastDate)),
    })
    expect(past?.kind).toBe('WORK') // past dates are eligibility evidence
  })

  it('audit-logs rep.days_off.set with before/after', async () => {
    await setRecurringDaysOff(db, { repId, daysOfWeek: [2], actorUserId: managerUserId })
    await setRecurringDaysOff(db, { repId, daysOfWeek: [4, 5], actorUserId: managerUserId })

    // ordered explicitly: Postgres row order is arbitrary, and "the last one" silently
    // became "some other one" once the table had enough churn from other tests.
    const events = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.action, 'rep.days_off.set'),
      orderBy: (t: any, { asc }: any) => [asc(t.createdAt)],
    })
    const mine = events.filter((e: any) => e.entityId === repId)
    const latest = mine[mine.length - 1]
    expect((latest.before as any).daysOfWeek).toEqual([2])
    expect((latest.after as any).daysOfWeek).toEqual([4, 5])
  })

  it('CONFIGURATION_ERROR stops being the normal case once shifts are materialized', async () => {
    await db.delete(schema.repShift).where(eq(schema.repShift.repId, repId))

    // with no shift row at all, the fail-safe fires
    await evaluateRepEligibility(db, { repId, businessDate: TUESDAY, policyId: enforcePolicyId })
    expect((await statusOn(repId, TUESDAY))?.status).toBe('CONFIGURATION_ERROR')

    // after materialization it evaluates normally
    await db.delete(schema.repDailyStatus).where(eq(schema.repDailyStatus.repId, repId))
    await materializeShifts(db, { fromDate: MONDAY, days: 14, repIds: [repId] })
    await setCalls(repId, MONDAY, 12)
    await evaluateRepEligibility(db, { repId, businessDate: TUESDAY, policyId: enforcePolicyId })
    expect((await statusOn(repId, TUESDAY))?.status).toBe('ELIGIBLE')
  })
})
