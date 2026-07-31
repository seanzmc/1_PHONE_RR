import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { t } from '../trpc/router'
import { repRouter } from './rep'
import type { Context } from '../trpc/context'
import type { Role } from '@phoneup/contracts'
import { setRecurringDaysOff } from '../domain/daysOff'

const fakeReqRes = { req: {} as Context['req'], res: {} as Context['res'] }

function fakeSession(userId: string, role: Role): NonNullable<Context['session']> {
  return { userId, role, mustChangePassword: false, sessionId: `test-session-${userId}` }
}

function caller(role: Role) {
  return t.createCallerFactory(repRouter)({ session: fakeSession('rep-router-test', role), ...fakeReqRes })
}

let repWithDayOff: string
let repWithout: string
let managerUserId: string

beforeAll(async () => {
  const reps = await db.select().from(schema.salesRep)
  if (reps.length < 2) throw new Error('test database needs at least two sales_rep rows — run the seed')
  repWithDayOff = reps[0].id
  repWithout = reps[1].id

  const [manager] = await db
    .insert(schema.appUser)
    .values({
      email: `rep-router-test-manager-${Date.now()}@dealership.test`,
      passwordHash: 'x:y',
      role: 'MANAGER',
    })
    .returning()
  managerUserId = manager.id

  await db.delete(schema.repRecurringDayOff).where(eq(schema.repRecurringDayOff.repId, repWithout))
  await setRecurringDaysOff(db, { repId: repWithDayOff, daysOfWeek: [3], actorUserId: managerUserId })
})

describe('rep.allDaysOff', () => {
  it('rejects a BDC agent — this is schedule.manage', async () => {
    await expect(caller('BDC').allDaysOff()).rejects.toThrow(/FORBIDDEN/)
  })

  it('rejects a REP', async () => {
    await expect(caller('REP').allDaysOff()).rejects.toThrow(/FORBIDDEN/)
  })

  it('returns a rep with a day off', async () => {
    const result = await caller('MANAGER').allDaysOff()
    expect(result[repWithDayOff]).toEqual([3])
  })

  it('includes a rep with no day off as an empty array, not as a missing key', async () => {
    // The client must not have to tell "no day off" apart from "not loaded".
    const result = await caller('MANAGER').allDaysOff()
    expect(result[repWithout]).toEqual([])
  })

  it('covers every rep on the roster', async () => {
    const result = await caller('MANAGER').allDaysOff()
    const reps = await db.select().from(schema.salesRep)
    expect(Object.keys(result).sort()).toEqual(reps.map((r: any) => r.id).sort())
  })
})
