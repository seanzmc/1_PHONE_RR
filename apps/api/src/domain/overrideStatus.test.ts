import { describe, it, expect, beforeAll } from 'vitest'
import { eq, and, desc } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { overrideStatus } from './overrideStatus'
import { businessDate } from '@phoneup/core'

let repId: string
let managerUserId: string

beforeAll(async () => {
  const rep = (await db.select().from(schema.salesRep))[0]
  repId = rep.id
  const [manager] = await db
    .insert(schema.appUser)
    .values({ email: 'override-test-manager@dealership.test', passwordHash: 'x:y', role: 'MANAGER' })
    .returning()
  managerUserId = manager.id
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
  })
})
