import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import {
  previewDailyActivity,
  commitDailyActivity,
  createAuthenticatedPreviewToken,
  previewTokensMatch,
} from './activityImportDecision'

const REPORT_DATE = '2042-04-08' // Tuesday
const STATUS_DATE = '2042-04-09' // Wednesday; week tail ends Saturday 04-12
const PRIOR_DATE = '2042-04-07' // Monday

function buildCsv(rows: Array<{ user: string; calls: number; sold?: number }>): string {
  const band = Array(29).fill('')
  band[1] = 'Opportunities'
  band[13] = 'Activity'
  const headers = Array(29).fill('')
  headers[0] = 'User'
  headers[13] = 'Calls'
  headers[26] = 'Sold'
  const quote = (cells: Array<string | number>) => cells.map((c) => `"${c}"`).join(',')
  const lines = rows.map((row) => {
    const cells: Array<string | number> = Array(29).fill('0')
    cells[0] = row.user
    cells[13] = row.calls
    cells[26] = row.sold ?? 0
    return quote(cells)
  })
  return '\uFEFF' + [quote(band), quote(headers), ...lines].join('\r\n')
}

let actorUserId: string
let policyId: string
let passingRep: any
let failingRep: any
let dayOffRep: any
let overrideRep: any
let repIds: string[]

beforeAll(async () => {
  // The project test database persists between invocations. Remove fixed-date shifts left by
  // an interrupted/earlier run so old synthetic reps cannot appear as legitimate zero-call
  // candidates in this run's all-roster preview.
  await db
    .delete(schema.repShift)
    .where(inArray(schema.repShift.businessDate, [PRIOR_DATE, REPORT_DATE, STATUS_DATE]))

  const admin = await db.query.appUser.findFirst({ where: eq(schema.appUser.role, 'ADMIN') })
  actorUserId = admin!.id

  const [policy] = await db
    .insert(schema.workRequirementPolicy)
    .values({ minCalls: 10, maxPriorWorkdayAge: 7, enforcementMode: 'SHADOW' })
    .returning()
  policyId = policy.id

  async function makeRep(label: string) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const [user] = await db
      .insert(schema.appUser)
      .values({ email: `activity-decision-${stamp}@test.invalid`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    const [rep] = await db
      .insert(schema.salesRep)
      .values({ userId: user.id, displayName: `${label} ${stamp}`, hireDate: '2020-01-01' })
      .returning()
    return rep
  }

  passingRep = await makeRep('Preview Passing')
  failingRep = await makeRep('Preview Failing')
  dayOffRep = await makeRep('Preview Day Off')
  overrideRep = await makeRep('Preview Override')
  repIds = [passingRep.id, failingRep.id, dayOffRep.id, overrideRep.id]

  await db.insert(schema.repShift).values([
    { repId: passingRep.id, businessDate: REPORT_DATE, kind: 'WORK' },
    { repId: passingRep.id, businessDate: STATUS_DATE, kind: 'WORK' },
    { repId: failingRep.id, businessDate: REPORT_DATE, kind: 'WORK' },
    { repId: failingRep.id, businessDate: STATUS_DATE, kind: 'WORK' },
    { repId: dayOffRep.id, businessDate: PRIOR_DATE, kind: 'WORK' },
    { repId: dayOffRep.id, businessDate: REPORT_DATE, kind: 'OFF' },
    { repId: dayOffRep.id, businessDate: STATUS_DATE, kind: 'WORK' },
    { repId: overrideRep.id, businessDate: REPORT_DATE, kind: 'WORK' },
    { repId: overrideRep.id, businessDate: STATUS_DATE, kind: 'WORK' },
  ])
})

beforeEach(async () => {
  await db.delete(schema.eligibilitySnapshot).where(inArray(schema.eligibilitySnapshot.repId, repIds))
  await db.delete(schema.repDailyStatus).where(inArray(schema.repDailyStatus.repId, repIds))
  await db.delete(schema.repDailyActivity).where(inArray(schema.repDailyActivity.repId, repIds))

  // Day-off carry-forward: Wednesday judges this rep on Monday, not Tuesday's zero.
  await db.insert(schema.repDailyActivity).values({
    repId: dayOffRep.id,
    businessDate: PRIOR_DATE,
    calls: 12,
    sold: 0,
    source: 'IMPORT',
  })

  // A manager activation remains subject to later failing activity evidence.
  await db.insert(schema.repDailyStatus).values({
    repId: overrideRep.id,
    businessDate: STATUS_DATE,
    status: 'ELIGIBLE',
    reason: 'manager kept rep active',
    decidedBy: 'MANAGER_OVERRIDE',
  })
})

function csv() {
  return buildCsv([
    { user: passingRep.displayName, calls: 14, sold: 1 },
    { user: failingRep.displayName, calls: 3 },
    { user: dayOffRep.displayName, calls: 0 },
    { user: overrideRep.displayName, calls: 2 },
  ])
}

describe('activity import preview token authentication', () => {
  it('does not accept a digest reproducible from only public nonce and fingerprint data', () => {
    const nonce = 'ab'.repeat(32)
    const fingerprint = JSON.stringify({ reportHash: 'public', statusDate: STATUS_DATE })
    const publiclyForgeable = `${nonce}${createHash('sha256')
      .update(`${nonce}\0${fingerprint}`)
      .digest('hex')}`

    expect(createAuthenticatedPreviewToken(fingerprint, nonce)).not.toBe(publiclyForgeable)
  })

  it('compares only well-formed authenticated tokens', () => {
    const token = createAuthenticatedPreviewToken('reviewed facts', 'cd'.repeat(32))
    expect(previewTokensMatch(token, token)).toBe(true)
    expect(previewTokensMatch('not-a-token', token)).toBe(false)
    const changedLastNibble = token.endsWith('0') ? '1' : '0'
    expect(previewTokensMatch(`${token.slice(0, -1)}${changedLastNibble}`, token)).toBe(false)
  })
})

async function preview() {
  return previewDailyActivity(db, csv(), REPORT_DATE, { statusDate: STATUS_DATE, policyId })
}

describe('activity import preview', () => {
  it('calculates the proposed DQs without writing activity, snapshots, status, or audit', async () => {
    const auditBefore = await db.select().from(schema.auditEvents)

    const result = await preview()

    expect(result.ineligibleReps.map((r) => r.repId)).toEqual([failingRep.id, overrideRep.id])
    expect(result.ineligibleReps[0]).toMatchObject({
      displayName: failingRep.displayName,
      callsFound: 3,
      evaluatedPriorWorkday: REPORT_DATE,
      minCallsRequired: 10,
    })
    expect(result.eligibleRepsCount).toBe(2) // passing + carry-forward day-off rep
    expect(result.repsMatched).toBe(4)
    expect(result.previewToken).toMatch(/^[a-f0-9]{128}$/)
    expect((await preview()).previewToken).not.toBe(result.previewToken)

    const reportRows = await db.query.repDailyActivity.findMany({
      where: and(
        inArray(schema.repDailyActivity.repId, repIds),
        eq(schema.repDailyActivity.businessDate, REPORT_DATE),
      ),
    })
    expect(reportRows).toEqual([])
    expect(await db.query.eligibilitySnapshot.findMany({
      where: inArray(schema.eligibilitySnapshot.repId, repIds),
    })).toEqual([])

    const statuses = await db.query.repDailyStatus.findMany({
      where: inArray(schema.repDailyStatus.repId, repIds),
    })
    expect(statuses).toHaveLength(1) // only the pre-existing manager override
    expect((await db.select().from(schema.auditEvents)).length).toBe(auditBefore.length)
  })

  it('uses the last worked day for a rep who was off on the report date', async () => {
    const result = await preview()
    const rep = result.eligibleReps.find((r) => r.repId === dayOffRep.id)
    expect(rep).toMatchObject({ evaluatedPriorWorkday: PRIOR_DATE, callsFound: 12 })
  })
})

describe('activity import decision', () => {
  it('LOG_ONLY saves the metrics and snapshots but changes no eligibility statuses', async () => {
    const p = await preview()
    const result = await commitDailyActivity(
      db,
      {
        csv: csv(),
        businessDate: REPORT_DATE,
        statusDate: STATUS_DATE,
        previewToken: p.previewToken,
        decision: 'LOG_ONLY',
        actorUserId,
      },
      { policyId },
    )

    expect(result.decision).toBe('LOG_ONLY')
    expect(result.deactivatedCount).toBe(0)
    const failActivity = await db.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, failingRep.id),
        eq(schema.repDailyActivity.businessDate, REPORT_DATE),
      ),
    })
    expect(failActivity?.calls).toBe(3)

    const failStatuses = await db.query.repDailyStatus.findMany({
      where: eq(schema.repDailyStatus.repId, failingRep.id),
    })
    expect(failStatuses).toEqual([])
    expect(await db.query.repDailyStatus.findFirst({
      where: and(
        eq(schema.repDailyStatus.repId, overrideRep.id),
        eq(schema.repDailyStatus.businessDate, STATUS_DATE),
      ),
    })).toMatchObject({ status: 'ELIGIBLE', decidedBy: 'MANAGER_OVERRIDE' })
    expect(await db.query.eligibilitySnapshot.findMany({
      where: inArray(schema.eligibilitySnapshot.repId, repIds),
    })).toHaveLength(4)

    const events = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.action, 'activity.import'),
    })
    expect(events.at(-1)?.after).toMatchObject({ decision: 'LOG_ONLY', ineligibleReps: 2 })
  })

  it('rejects a replayed preview token without duplicating snapshots or audit events', async () => {
    const p = await preview()
    const input = {
      csv: csv(),
      businessDate: REPORT_DATE,
      statusDate: STATUS_DATE,
      previewToken: p.previewToken,
      decision: 'LOG_ONLY' as const,
      actorUserId,
    }
    await commitDailyActivity(db, input, { policyId })
    const snapshotsBefore = await db.query.eligibilitySnapshot.findMany({
      where: inArray(schema.eligibilitySnapshot.repId, repIds),
    })
    const auditsBefore = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.action, 'activity.import'),
    })

    await expect(commitDailyActivity(db, input, { policyId })).rejects.toThrow(/PREVIEW_ALREADY_COMMITTED/)

    expect(await db.query.eligibilitySnapshot.findMany({
      where: inArray(schema.eligibilitySnapshot.repId, repIds),
    })).toHaveLength(snapshotsBefore.length)
    expect(await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.action, 'activity.import'),
    })).toHaveLength(auditsBefore.length)
  })

  it('rejects a valid token with a trailing line terminator without writing', async () => {
    const p = await preview()
    const auditsBefore = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.action, 'activity.import'),
    })

    await expect(
      commitDailyActivity(
        db,
        {
          csv: csv(),
          businessDate: REPORT_DATE,
          statusDate: STATUS_DATE,
          previewToken: `${p.previewToken}\n`,
          decision: 'LOG_ONLY',
          actorUserId,
        },
        { policyId },
      ),
    ).rejects.toThrow(/PREVIEW_STALE/)

    expect(
      await db.query.repDailyActivity.findMany({
        where: and(
          inArray(schema.repDailyActivity.repId, repIds),
          eq(schema.repDailyActivity.businessDate, REPORT_DATE),
        ),
      }),
    ).toEqual([])
    expect(
      await db.query.eligibilitySnapshot.findMany({
        where: inArray(schema.eligibilitySnapshot.repId, repIds),
      }),
    ).toEqual([])
    expect(
      await db.query.auditEvents.findMany({
        where: eq(schema.auditEvents.action, 'activity.import'),
      }),
    ).toHaveLength(auditsBefore.length)
  })

  it('allows exactly one of two concurrent commits using the same preview token', async () => {
    const p = await preview()
    const input = {
      csv: csv(),
      businessDate: REPORT_DATE,
      statusDate: STATUS_DATE,
      previewToken: p.previewToken,
      decision: 'LOG_ONLY' as const,
      actorUserId,
    }
    const auditsBefore = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.action, 'activity.import'),
    })

    const results = await Promise.allSettled([
      commitDailyActivity(db, input, { policyId }),
      commitDailyActivity(db, input, { policyId }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ status: 'rejected' })
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      message: expect.stringMatching(/PREVIEW_ALREADY_COMMITTED/),
    })
    expect(
      await db.query.auditEvents.findMany({
        where: eq(schema.auditEvents.action, 'activity.import'),
      }),
    ).toHaveLength(auditsBefore.length + 1)
  })

  it('LOG_AND_DEACTIVATE writes failing reps through Saturday including manager-active', async () => {
    const p = await preview()
    expect(p.ineligibleReps.map((rep) => rep.repId)).toContain(overrideRep.id)

    const result = await commitDailyActivity(
      db,
      {
        csv: csv(),
        businessDate: REPORT_DATE,
        statusDate: STATUS_DATE,
        previewToken: p.previewToken,
        decision: 'LOG_AND_DEACTIVATE',
        actorUserId,
      },
      { policyId },
    )

    expect(result.deactivatedCount).toBe(2)
    const failStatuses = await db.query.repDailyStatus.findMany({
      where: eq(schema.repDailyStatus.repId, failingRep.id),
    })
    expect(failStatuses.map((s) => s.businessDate).sort()).toEqual([
      '2042-04-09',
      '2042-04-10',
      '2042-04-11',
      '2042-04-12',
    ])
    expect(failStatuses.every((s) => s.status === 'INELIGIBLE')).toBe(true)
    expect(failStatuses.every((s) => s.reason?.startsWith('WEEK_DQ: 3 calls'))).toBe(true)

    const passToday = await db.query.repDailyStatus.findFirst({
      where: and(
        eq(schema.repDailyStatus.repId, passingRep.id),
        eq(schema.repDailyStatus.businessDate, STATUS_DATE),
      ),
    })
    expect(passToday).toBeUndefined()

    const override = await db.query.repDailyStatus.findFirst({
      where: and(
        eq(schema.repDailyStatus.repId, overrideRep.id),
        eq(schema.repDailyStatus.businessDate, STATUS_DATE),
      ),
    })
    expect(override).toMatchObject({ status: 'INELIGIBLE', decidedBy: 'SYSTEM' })
  })

  it('leaves a passing manager-active rep eligible without an activation write', async () => {
    const [managerStatus] = await db
      .insert(schema.repDailyStatus)
      .values({
        repId: passingRep.id,
        businessDate: STATUS_DATE,
        status: 'ELIGIBLE',
        reason: 'manager kept passing rep active',
        decidedBy: 'MANAGER_OVERRIDE',
      })
      .returning()
    const p = await preview()
    expect(p.eligibleReps.map((rep) => rep.repId)).toContain(passingRep.id)

    await commitDailyActivity(
      db,
      {
        csv: csv(),
        businessDate: REPORT_DATE,
        statusDate: STATUS_DATE,
        previewToken: p.previewToken,
        decision: 'LOG_AND_DEACTIVATE',
        actorUserId,
      },
      { policyId },
    )

    const statuses = await db.query.repDailyStatus.findMany({
      where: eq(schema.repDailyStatus.repId, passingRep.id),
    })
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({
      id: managerStatus.id,
      status: 'ELIGIBLE',
      reason: 'manager kept passing rep active',
      decidedBy: 'MANAGER_OVERRIDE',
    })
  })

  it('skips manager-inactive without presenting an auto-reactivation candidate', async () => {
    await db
      .update(schema.repDailyStatus)
      .set({ status: 'INELIGIBLE', reason: 'manager kept rep inactive' })
      .where(
        and(
          eq(schema.repDailyStatus.repId, overrideRep.id),
          eq(schema.repDailyStatus.businessDate, STATUS_DATE),
        ),
      )
    const p = await preview()
    expect(p.eligibleReps.map((rep) => rep.repId)).not.toContain(overrideRep.id)
    expect(p.ineligibleReps.map((rep) => rep.repId)).not.toContain(overrideRep.id)
    expect(p.notEvaluatedReps).toContainEqual({
      repId: overrideRep.id,
      displayName: overrideRep.displayName,
      reason: 'already inactive by manager decision',
    })

    await commitDailyActivity(
      db,
      {
        csv: csv(),
        businessDate: REPORT_DATE,
        statusDate: STATUS_DATE,
        previewToken: p.previewToken,
        decision: 'LOG_AND_DEACTIVATE',
        actorUserId,
      },
      { policyId },
    )

    const statuses = await db.query.repDailyStatus.findMany({
      where: eq(schema.repDailyStatus.repId, overrideRep.id),
    })
    expect(statuses).toHaveLength(1)
    expect(statuses[0]).toMatchObject({
      status: 'INELIGIBLE',
      reason: 'manager kept rep inactive',
      decidedBy: 'MANAGER_OVERRIDE',
    })
  })

  it('rejects a stale preview and leaves the report uncommitted', async () => {
    const p = await preview()
    // A manager corrects the row while the decision screen is open. The old DQ preview
    // must not be applied against newly-changed facts.
    await db.insert(schema.repDailyActivity).values({
      repId: failingRep.id,
      businessDate: REPORT_DATE,
      calls: 15,
      sold: 0,
      source: 'MANUAL',
    })

    await expect(
      commitDailyActivity(
        db,
        {
          csv: csv(),
          businessDate: REPORT_DATE,
          statusDate: STATUS_DATE,
          previewToken: p.previewToken,
          decision: 'LOG_AND_DEACTIVATE',
          actorUserId,
        },
        { policyId },
      ),
    ).rejects.toThrow(/PREVIEW_STALE/)

    expect(await db.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, passingRep.id),
        eq(schema.repDailyActivity.businessDate, REPORT_DATE),
      ),
    })).toBeUndefined()
    expect(await db.query.repDailyStatus.findMany({
      where: eq(schema.repDailyStatus.repId, failingRep.id),
    })).toEqual([])
  })

  it('zeros a stale imported total when the reviewed re-import omits that rep', async () => {
    await db.insert(schema.repDailyActivity).values({
      repId: failingRep.id,
      businessDate: REPORT_DATE,
      calls: 15,
      sold: 2,
      source: 'IMPORT',
    })
    const withoutFailing = buildCsv([
      { user: passingRep.displayName, calls: 14, sold: 1 },
      { user: dayOffRep.displayName, calls: 0 },
      { user: overrideRep.displayName, calls: 2 },
    ])
    const p = await previewDailyActivity(db, withoutFailing, REPORT_DATE, {
      statusDate: STATUS_DATE,
      policyId,
    })
    expect(p.ineligibleReps).toContainEqual(
      expect.objectContaining({ repId: failingRep.id, callsFound: 0 }),
    )

    await commitDailyActivity(
      db,
      {
        csv: withoutFailing,
        businessDate: REPORT_DATE,
        statusDate: STATUS_DATE,
        previewToken: p.previewToken,
        decision: 'LOG_AND_DEACTIVATE',
        actorUserId,
      },
      { policyId },
    )

    const activity = await db.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, failingRep.id),
        eq(schema.repDailyActivity.businessDate, REPORT_DATE),
      ),
    })
    expect(activity).toMatchObject({ calls: 0, sold: 0, source: 'IMPORT' })
  })

  it('does not reactivate an eligible rep who already has a system weekly DQ', async () => {
    await db.insert(schema.repDailyStatus).values([
      {
        repId: passingRep.id,
        businessDate: STATUS_DATE,
        status: 'INELIGIBLE',
        reason: 'WEEK_DQ: existing weekly suspension',
        decidedBy: 'SYSTEM',
      },
      {
        repId: passingRep.id,
        businessDate: '2042-04-10',
        status: 'INELIGIBLE',
        reason: 'WEEK_DQ: existing weekly suspension',
        decidedBy: 'SYSTEM',
      },
    ])
    const p = await preview()

    await commitDailyActivity(
      db,
      {
        csv: csv(),
        businessDate: REPORT_DATE,
        statusDate: STATUS_DATE,
        previewToken: p.previewToken,
        decision: 'LOG_AND_DEACTIVATE',
        actorUserId,
      },
      { policyId },
    )

    const statuses = await db.query.repDailyStatus.findMany({
      where: eq(schema.repDailyStatus.repId, passingRep.id),
    })
    expect(statuses).toHaveLength(2)
    expect(statuses.every((status) => status.status === 'INELIGIBLE')).toBe(true)
    expect(statuses.every((status) => status.reason === 'WEEK_DQ: existing weekly suspension')).toBe(true)
  })

  it('rejects the old token when a future manager status changes after preview', async () => {
    const p = await preview()
    await db.insert(schema.repDailyStatus).values({
      repId: failingRep.id,
      businessDate: '2042-04-10',
      status: 'ELIGIBLE',
      reason: 'manager future exception',
      decidedBy: 'MANAGER_OVERRIDE',
    })

    await expect(
      commitDailyActivity(
        db,
        {
          csv: csv(),
          businessDate: REPORT_DATE,
          statusDate: STATUS_DATE,
          previewToken: p.previewToken,
          decision: 'LOG_AND_DEACTIVATE',
          actorUserId,
        },
        { policyId },
      ),
    ).rejects.toThrow(/PREVIEW_STALE/)
  })

  it('waits for the shared lock and then rejects a correction committed ahead of it', async () => {
    const p = await preview()
    let release!: () => void
    let locked!: () => void
    const lockAcquired = new Promise<void>((resolve) => {
      locked = resolve
    })
    const releaseLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const correction = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${42_100_1})`)
      await tx.insert(schema.repDailyActivity).values({
        repId: failingRep.id,
        businessDate: REPORT_DATE,
        calls: 15,
        sold: 0,
        source: 'MANUAL',
      })
      locked()
      await releaseLock
    })
    await lockAcquired

    let settled = false
    const commit = commitDailyActivity(
      db,
      {
        csv: csv(),
        businessDate: REPORT_DATE,
        statusDate: STATUS_DATE,
        previewToken: p.previewToken,
        decision: 'LOG_ONLY',
        actorUserId,
      },
      { policyId },
    ).finally(() => {
      settled = true
    })
    const staleAssertion = expect(commit).rejects.toThrow(/PREVIEW_STALE/)

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    release()
    await correction
    await staleAssertion
  })
})
