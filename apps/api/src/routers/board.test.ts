import { describe, it, expect, beforeAll } from 'vitest'
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

  async function makeRep(label: string): Promise<string> {
    const [user] = await db
      .insert(schema.appUser)
      .values({ email: `board-test-${label}-${stamp}@dealership.test`, passwordHash: 'x:y', role: 'REP' })
      .returning()
    const [rep] = await db
      .insert(schema.salesRep)
      .values({ userId: user.id, displayName: `Board Test ${label} ${stamp}`, hireDate: '2020-01-01' })
      .returning()
    return rep.id
  }

  beforeAll(async () => {
    repWithManagerOverride = await makeRep('override')
    repWithSystemStatus = await makeRep('system')
    repWithNoRowToday = await makeRep('norow')

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
    ])
    // repWithNoRowToday deliberately gets no rep_daily_status row for today.
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
})
