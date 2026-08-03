import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { businessDate } from '@phoneup/core'
import { db, schema } from '@phoneup/db'
import { bus } from '../realtime/bus'
import { materializeShiftsLocked } from '../jobs/eligibility'
import { selectActiveReps } from './activeReps'
import {
  bulkSetRecurringDaysOff,
  getRecurringDaysOff,
  setRecurringDaysOff,
} from './daysOff'

vi.mock('../jobs/eligibility', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jobs/eligibility')>()
  return {
    ...actual,
    materializeShiftsLocked: vi.fn(),
  }
})

let repIds: string[]
let managerUserId: string
let inactiveRepId: string
let inactiveUserId: string
let realMaterializeShiftsLocked: typeof materializeShiftsLocked
let realtimeEvents: unknown[]
const onAssignment = (event: unknown) => realtimeEvents.push(event)

beforeAll(async () => {
  const reps = await selectActiveReps(db)
  if (reps.length < 2) throw new Error('test database needs at least two active sales_rep rows — run the seed')
  repIds = reps.slice(0, 2).map((rep: any) => rep.id)

  const [manager] = await db
    .insert(schema.appUser)
    .values({
      email: `days-off-test-manager-${Date.now()}@dealership.test`,
      passwordHash: 'x:y',
      role: 'MANAGER',
    })
    .returning()
  managerUserId = manager.id

  const [inactiveUser] = await db
    .insert(schema.appUser)
    .values({
      email: `days-off-test-inactive-${Date.now()}@dealership.test`,
      passwordHash: 'x:y',
      role: 'REP',
      isActive: false,
    })
    .returning()
  inactiveUserId = inactiveUser.id
  const [inactiveRep] = await db
    .insert(schema.salesRep)
    .values({ userId: inactiveUserId, displayName: 'Inactive Days Off Test Rep', hireDate: '2024-01-01' })
    .returning()
  inactiveRepId = inactiveRep.id

  const actual = await vi.importActual<typeof import('../jobs/eligibility')>('../jobs/eligibility')
  realMaterializeShiftsLocked = actual.materializeShiftsLocked
  bus.on('assignment', onAssignment)
})

beforeEach(async () => {
  await db.delete(schema.repRecurringDayOff).where(inArray(schema.repRecurringDayOff.repId, [...repIds, inactiveRepId]))
  await db.delete(schema.auditEvents).where(and(
    eq(schema.auditEvents.action, 'rep.days_off.set'),
    eq(schema.auditEvents.actorUserId, managerUserId),
  ))
  vi.mocked(materializeShiftsLocked).mockReset()
  vi.mocked(materializeShiftsLocked).mockImplementation(realMaterializeShiftsLocked)
  realtimeEvents = []
})

afterAll(async () => {
  bus.off('assignment', onAssignment)
  await db.delete(schema.repRecurringDayOff).where(eq(schema.repRecurringDayOff.repId, inactiveRepId))
  await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, managerUserId))
  await db.delete(schema.salesRep).where(eq(schema.salesRep.id, inactiveRepId))
  await db.delete(schema.appUser).where(eq(schema.appUser.id, inactiveUserId))
  await db.delete(schema.appUser).where(eq(schema.appUser.id, managerUserId))
})

describe('bulkSetRecurringDaysOff', () => {
  it('normalizes requested days, changes only differing reps, audits once, and publishes once after commit', async () => {
    await db.insert(schema.repRecurringDayOff).values({ repId: repIds[0], dayOfWeek: 2 })

    const result = await bulkSetRecurringDaysOff(db, {
      actorUserId: managerUserId,
      changes: [
        { repId: repIds[0], daysOfWeek: [0, 3] },
        { repId: repIds[1], daysOfWeek: [] },
      ],
    })

    expect(result.changedRepIds).toEqual([repIds[0]])
    expect(result.daysOffByRep).toEqual({ [repIds[0]]: [3], [repIds[1]]: [] })
    expect(await getRecurringDaysOff(db, repIds[0])).toEqual([3])
    expect(await getRecurringDaysOff(db, repIds[1])).toEqual([])

    const audits = await db.query.auditEvents.findMany({
      where: and(
        eq(schema.auditEvents.action, 'rep.days_off.set'),
        eq(schema.auditEvents.actorUserId, managerUserId),
      ),
    })
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      entityType: 'sales_rep',
      entityId: repIds[0],
      before: { daysOfWeek: [2] },
      after: { daysOfWeek: [3] },
    })
    expect(realtimeEvents).toEqual([
      { type: 'ELIGIBILITY_UPDATED', statusDate: businessDate(new Date()) },
    ])
  })

  it('writes one audit event per changed rep', async () => {
    await bulkSetRecurringDaysOff(db, {
      actorUserId: managerUserId,
      changes: [
        { repId: repIds[0], daysOfWeek: [2] },
        { repId: repIds[1], daysOfWeek: [4] },
      ],
    })

    const audits = await db.query.auditEvents.findMany({
      where: and(
        eq(schema.auditEvents.action, 'rep.days_off.set'),
        eq(schema.auditEvents.actorUserId, managerUserId),
      ),
    })
    expect(audits).toHaveLength(2)
    expect(audits.map((event: any) => event.entityId).sort()).toEqual([...repIds].sort())
    expect(realtimeEvents).toHaveLength(1)
  })

  it('rejects two working days before any day-off, audit, materialization, or realtime side effect', async () => {
    await db.insert(schema.repRecurringDayOff).values({ repId: repIds[0], dayOfWeek: 2 })

    await expect(bulkSetRecurringDaysOff(db, {
      actorUserId: managerUserId,
      changes: [
        { repId: repIds[0], daysOfWeek: [3, 4] },
        { repId: repIds[1], daysOfWeek: [5] },
      ],
    })).rejects.toThrow(/at most one recurring day off/)

    expect(await getRecurringDaysOff(db, repIds[0])).toEqual([2])
    expect(await getRecurringDaysOff(db, repIds[1])).toEqual([])
    expect(await db.query.auditEvents.findMany({
      where: and(
        eq(schema.auditEvents.action, 'rep.days_off.set'),
        eq(schema.auditEvents.actorUserId, managerUserId),
      ),
    })).toHaveLength(0)
    expect(materializeShiftsLocked).not.toHaveBeenCalled()
    expect(realtimeEvents).toHaveLength(0)
  })

  it.each([
    ['unknown', '00000000-0000-0000-0000-000000000000'],
    ['inactive', () => inactiveRepId],
  ])('rejects the whole batch when a target rep is %s', async (_label, target) => {
    const rejectedRepId = typeof target === 'function' ? target() : target

    await expect(bulkSetRecurringDaysOff(db, {
      actorUserId: managerUserId,
      changes: [
        { repId: repIds[0], daysOfWeek: [3] },
        { repId: rejectedRepId, daysOfWeek: [4] },
      ],
    })).rejects.toThrow(/unknown or inactive repId/)

    expect(await getRecurringDaysOff(db, repIds[0])).toEqual([])
    expect(await db.query.auditEvents.findMany({
      where: and(
        eq(schema.auditEvents.action, 'rep.days_off.set'),
        eq(schema.auditEvents.actorUserId, managerUserId),
      ),
    })).toHaveLength(0)
    expect(materializeShiftsLocked).not.toHaveBeenCalled()
    expect(realtimeEvents).toHaveLength(0)
  })

  it('treats identical rows as a no-op with no audit, materialization, or realtime event', async () => {
    await db.insert(schema.repRecurringDayOff).values({ repId: repIds[0], dayOfWeek: 3 })

    const result = await bulkSetRecurringDaysOff(db, {
      actorUserId: managerUserId,
      changes: [
        { repId: repIds[0], daysOfWeek: [3, 3] },
        { repId: repIds[1], daysOfWeek: [] },
      ],
    })

    expect(result).toEqual({
      changedRepIds: [],
      daysOffByRep: { [repIds[0]]: [3], [repIds[1]]: [] },
    })
    expect(await db.query.auditEvents.findMany({
      where: and(
        eq(schema.auditEvents.action, 'rep.days_off.set'),
        eq(schema.auditEvents.actorUserId, managerUserId),
      ),
    })).toHaveLength(0)
    expect(materializeShiftsLocked).not.toHaveBeenCalled()
    expect(realtimeEvents).toHaveLength(0)
  })

  it('rolls back every day-off and audit write when materialization fails and does not publish', async () => {
    await db.insert(schema.repRecurringDayOff).values({ repId: repIds[0], dayOfWeek: 2 })
    vi.mocked(materializeShiftsLocked).mockRejectedValueOnce(new Error('simulated materialization failure'))

    await expect(bulkSetRecurringDaysOff(db, {
      actorUserId: managerUserId,
      changes: [
        { repId: repIds[0], daysOfWeek: [3] },
        { repId: repIds[1], daysOfWeek: [4] },
      ],
    })).rejects.toThrow('simulated materialization failure')

    expect(await getRecurringDaysOff(db, repIds[0])).toEqual([2])
    expect(await getRecurringDaysOff(db, repIds[1])).toEqual([])
    expect(await db.query.auditEvents.findMany({
      where: and(
        eq(schema.auditEvents.action, 'rep.days_off.set'),
        eq(schema.auditEvents.actorUserId, managerUserId),
      ),
    })).toHaveLength(0)
    expect(realtimeEvents).toHaveLength(0)
  })
})

describe('setRecurringDaysOff — backward-compatible single setter', () => {
  it('returns the existing daysOff shape through the batch rule', async () => {
    const result = await setRecurringDaysOff(db, {
      repId: repIds[0],
      daysOfWeek: [0, 3],
      actorUserId: managerUserId,
    })
    expect(result).toEqual({ daysOff: [3] })
  })

  it('rejects two working days', async () => {
    await expect(setRecurringDaysOff(db, {
      repId: repIds[0],
      daysOfWeek: [4, 5],
      actorUserId: managerUserId,
    })).rejects.toThrow(/at most one recurring day off/)
  })
})
