import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { inArray, sql } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import { t } from '../trpc/router'
import { boardRouter } from './board'
import type { Context } from '../trpc/context'
import type { Role } from '@phoneup/contracts'

/**
 * `board.roster` is a tRPC procedure gated on a session (`requirePerm('board.view')`), so
 * it is exercised through a real caller built with `t.createCallerFactory`, the same
 * pattern `userManagementRouter.test.ts` uses — rather than exporting `computeRoster` and
 * reconstructing the response-layer merge by hand. `computeRoster` is intentionally left
 * module-private: calling the router directly already exercises the real merge (the
 * `decidedByRep` map built in `computeRoster`, merged onto `nameById` in `roster`) against
 * the live test database, with less contortion than faking that merge in the test.
 */

const fakeReqRes = { req: {} as Context['req'], res: {} as Context['res'] }

function fakeSession(userId: string, role: Role): NonNullable<Context['session']> {
  return { userId, role, mustChangePassword: false, sessionId: `test-session-${userId}` }
}

function caller() {
  return t.createCallerFactory(boardRouter)({ session: fakeSession('board-test-manager', 'MANAGER'), ...fakeReqRes })
}

describe('board.roster — decidedBy', () => {
  const today = businessDate(new Date())
  const stamp = Date.now()

  let repWithManagerOverride: string
  let repWithSystemStatus: string
  let repWithNoRowToday: string
  let disabledRep: string
  const fixtureUserIds: string[] = []
  const fixtureRepIds: string[] = []
  const userByRep = new Map<string, string>()

  async function makeRep(label: string): Promise<string> {
    const [user] = await db
      .insert(schema.appUser)
      .values({ email: `board-test-${label}-${stamp}@dealership.test`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    const [rep] = await db
      .insert(schema.salesRep)
      .values({ userId: user.id, displayName: `Board Test ${label} ${stamp}`, hireDate: '2020-01-01' })
      .returning()
    fixtureUserIds.push(user.id)
    fixtureRepIds.push(rep.id)
    userByRep.set(rep.id, user.id)
    return rep.id
  }

  beforeAll(async () => {
    repWithManagerOverride = await makeRep('override')
    repWithSystemStatus = await makeRep('system')
    repWithNoRowToday = await makeRep('norow')
    disabledRep = await makeRep('disabled')
    await db
      .update(schema.appUser)
      .set({ isActive: false })
      .where(inArray(schema.appUser.id, [userByRep.get(disabledRep)!]))

    await db.insert(schema.repDailyStatus).values([
      {
        repId: repWithManagerOverride,
        businessDate: today,
        status: 'INELIGIBLE',
        reason: 'manager sat them down',
        decidedBy: 'MANAGER_OVERRIDE',
      },
      {
        repId: repWithSystemStatus,
        businessDate: today,
        status: 'ELIGIBLE',
        decidedBy: 'SYSTEM',
      },
      {
        repId: disabledRep,
        businessDate: today,
        status: 'ELIGIBLE',
        decidedBy: 'SYSTEM',
      },
    ])
    // repWithNoRowToday deliberately gets no rep_daily_status row for today.
  })

  afterAll(async () => {
    // Other API test files assign concurrently. Cleanup takes the same ordering lock so
    // assignLead cannot select one of these reps and then lose it before writing status.
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${42_100_1})`)
      await tx.delete(schema.repDailyStatus).where(inArray(schema.repDailyStatus.repId, fixtureRepIds))
      await tx.delete(schema.salesRep).where(inArray(schema.salesRep.id, fixtureRepIds))
      await tx.delete(schema.appUser).where(inArray(schema.appUser.id, fixtureUserIds))
    })
  })

  it('reflects rep_daily_status.decidedBy for a rep with a manager-override row today', async () => {
    const roster = await caller().roster()
    const entry = roster.find((r) => r.repId === repWithManagerOverride)
    expect(entry).toBeDefined()
    expect(entry?.decidedBy).toBe('MANAGER_OVERRIDE')
  })

  it('reflects rep_daily_status.decidedBy for a rep with a system-decided row today', async () => {
    const roster = await caller().roster()
    const entry = roster.find((r) => r.repId === repWithSystemStatus)
    expect(entry).toBeDefined()
    expect(entry?.decidedBy).toBe('SYSTEM')
  })

  it('is exactly null, not undefined and not absent, when the rep has no row for today', async () => {
    const roster = await caller().roster()
    const entry = roster.find((r) => r.repId === repWithNoRowToday)
    expect(entry).toBeDefined()
    expect('decidedBy' in (entry as object)).toBe(true)
    // toBe(null) fails on undefined too — this is what catches a silent regression to
    // `decidedBy` being dropped or resolving to undefined instead of null.
    expect(entry?.decidedBy).toBe(null)
  })

  it('hides disabled accounts but keeps active ineligible reps visible', async () => {
    const roster = await caller().roster()
    expect(roster.some((entry) => entry.repId === disabledRep)).toBe(false)
    expect(roster.some((entry) => entry.repId === repWithManagerOverride && !entry.isEligible)).toBe(true)
  })
})
