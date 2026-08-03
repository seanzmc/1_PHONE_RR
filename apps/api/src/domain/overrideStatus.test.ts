import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { eq, and, desc } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { overrideStatus } from './overrideStatus'
import { businessDate } from '@phoneup/core'
import { publishAssignment } from '../realtime/bus'

vi.mock('../realtime/bus', () => ({ publishAssignment: vi.fn() }))

let repId: string
let managerUserId: string

beforeAll(async () => {
  const rep = (await db.select().from(schema.salesRep))[0]
  repId = rep.id
  const [manager] = await db
    .insert(schema.appUser)
    .values({ email: `override-test-manager-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'MANAGER' })
    .returning()
  managerUserId = manager.id
})

beforeEach(() => {
  vi.mocked(publishAssignment).mockClear()
})

describe('overrideStatus', () => {
  it('writes status_override, updates rep_daily_status, and logs an audit event', async () => {
    const today = businessDate(new Date())

    const before = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
    })

    await overrideStatus(db, {
      repId,
      status: 'FORCE_INACTIVE',
      reasonCode: 'PERSONAL_LEAVE',
      reasonNote: 'Out sick, manager-confirmed',
      actorUserId: managerUserId,
    })

    const overrides = await db.query.statusOverride.findMany({
      where: eq(schema.statusOverride.repId, repId),
      orderBy: desc(schema.statusOverride.createdAt),
    })
    expect(overrides[0].status).toBe('FORCE_INACTIVE')
    expect(overrides[0].reasonNote).toBe('Out sick, manager-confirmed')

    const status = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(status?.status).toBe('INELIGIBLE')
    expect(status?.decidedBy).toBe('MANAGER_OVERRIDE')

    const audit = await db.query.auditEvents.findMany({
      where: and(eq(schema.auditEvents.entityType, 'rep_daily_status'), eq(schema.auditEvents.entityId, repId)),
      orderBy: desc(schema.auditEvents.createdAt),
    })
    expect(audit[0].after).toMatchObject({ status: 'INELIGIBLE' })
    expect(audit[0].before).toMatchObject(before ? { status: before.status } : {})

    expect(publishAssignment).toHaveBeenCalledTimes(1)
    expect(publishAssignment).toHaveBeenCalledWith({
      type: 'ELIGIBILITY_UPDATED',
      statusDate: today,
    })
  })

  it('does not publish when the status transaction rolls back', async () => {
    const today = businessDate(new Date())
    const existing = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
    })
    if (existing) {
      await db
        .update(schema.repDailyStatus)
        .set({ status: 'ELIGIBLE', decidedBy: 'SYSTEM', reason: 'rollback baseline' })
        .where(eq(schema.repDailyStatus.id, existing.id))
    } else {
      await db.insert(schema.repDailyStatus).values({
        repId,
        businessDate: today,
        status: 'ELIGIBLE',
        decidedBy: 'SYSTEM',
        reason: 'rollback baseline',
      })
    }

    const rollbackDb = {
      transaction: (callback: (tx: any) => Promise<unknown>) =>
        db.transaction(async (tx) => {
          const failingTx = new Proxy(tx, {
            get(target, property, receiver) {
              if (property === 'insert') {
                return (table: unknown) => {
                  if (table === schema.auditEvents) {
                    return {
                      values: async () => {
                        throw new Error('simulated audit failure')
                      },
                    }
                  }
                  return target.insert(table as any)
                }
              }

              const value = Reflect.get(target, property, receiver)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
          return callback(failingTx)
        }),
    } as unknown as typeof db

    await expect(
      overrideStatus(rollbackDb, {
        repId,
        status: 'FORCE_INACTIVE',
        reasonCode: 'PERSONAL_LEAVE',
        reasonNote: 'Rollback test after writes',
        actorUserId: managerUserId,
      }),
    ).rejects.toThrow('simulated audit failure')

    const rolledBackStatus = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(rolledBackStatus).toMatchObject({ status: 'ELIGIBLE', decidedBy: 'SYSTEM' })

    const rolledBackOverride = await db.query.statusOverride.findFirst({
      where: and(
        eq(schema.statusOverride.repId, repId),
        eq(schema.statusOverride.reasonNote, 'Rollback test after writes'),
      ),
    })
    expect(rolledBackOverride).toBeUndefined()

    expect(publishAssignment).not.toHaveBeenCalled()
  })
})
