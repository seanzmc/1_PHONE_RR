import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { setRecurringDaysOff, getRecurringDaysOff } from './daysOff'

// Reuses reps the seed already created rather than inserting its own, matching
// bulkOverrideStatus.test.ts. Tests that insert sales_rep rows without deleting them
// accumulate across runs and have already caused a flake in this suite.
let repId: string
let managerUserId: string

beforeAll(async () => {
  const reps = await db.select().from(schema.salesRep)
  if (reps.length === 0) throw new Error('test database has no sales_rep rows — run the seed')
  repId = reps[0].id

  const [manager] = await db
    .insert(schema.appUser)
    .values({
      email: `days-off-test-manager-${Date.now()}@dealership.test`,
      passwordHash: 'x:y',
      role: 'MANAGER',
    })
    .returning()
  managerUserId = manager.id
})

beforeEach(async () => {
  await db.delete(schema.repRecurringDayOff).where(eq(schema.repRecurringDayOff.repId, repId))
})

describe('setRecurringDaysOff — at most one day', () => {
  it('accepts a single working day', async () => {
    const result = await setRecurringDaysOff(db, { repId, daysOfWeek: [3], actorUserId: managerUserId })
    expect(result.daysOff).toEqual([3])
    expect(await getRecurringDaysOff(db, repId)).toEqual([3])
  })

  it('accepts none', async () => {
    await setRecurringDaysOff(db, { repId, daysOfWeek: [3], actorUserId: managerUserId })
    const result = await setRecurringDaysOff(db, { repId, daysOfWeek: [], actorUserId: managerUserId })
    expect(result.daysOff).toEqual([])
    expect(await getRecurringDaysOff(db, repId)).toEqual([])
  })

  it('accepts Sunday plus one working day — Sunday is dropped, so that is one day off', async () => {
    // The store is closed Sunday. It needs no rep-level entry and must not consume one,
    // so [0, 3] is a rep off on Wednesday, not a rep off twice.
    const result = await setRecurringDaysOff(db, { repId, daysOfWeek: [0, 3], actorUserId: managerUserId })
    expect(result.daysOff).toEqual([3])
  })

  it('rejects two working days', async () => {
    await expect(
      setRecurringDaysOff(db, { repId, daysOfWeek: [4, 5], actorUserId: managerUserId }),
    ).rejects.toThrow(/at most one recurring day off/)
  })

  it('rejects every day of the week', async () => {
    await expect(
      setRecurringDaysOff(db, { repId, daysOfWeek: [1, 2, 3, 4, 5, 6], actorUserId: managerUserId }),
    ).rejects.toThrow(/at most one recurring day off/)
  })

  it('writes nothing at all when it rejects', async () => {
    await setRecurringDaysOff(db, { repId, daysOfWeek: [2], actorUserId: managerUserId })
    const auditBefore = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.entityId, repId),
    })

    await expect(
      setRecurringDaysOff(db, { repId, daysOfWeek: [4, 5], actorUserId: managerUserId }),
    ).rejects.toThrow()

    // The prior day off survives untouched — a rejected call must not have deleted it.
    expect(await getRecurringDaysOff(db, repId)).toEqual([2])
    const auditAfter = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.entityId, repId),
    })
    expect(auditAfter.length).toBe(auditBefore.length)
  })

  it('treats a duplicated day as one day', async () => {
    const result = await setRecurringDaysOff(db, { repId, daysOfWeek: [3, 3], actorUserId: managerUserId })
    expect(result.daysOff).toEqual([3])
  })
})
