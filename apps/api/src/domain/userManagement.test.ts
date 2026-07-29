import { describe, it, expect, beforeAll } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { createAccount } from './userManagement'
import { businessDate } from '@phoneup/core'

let actorUserId: string

beforeAll(async () => {
  const [actor] = await db
    .insert(schema.appUser)
    .values({ email: `um-test-actor-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'ADMIN' })
    .returning()
  actorUserId = actor.id
})

describe('createAccount', () => {
  it('creates a BDC account with no rotation rows', async () => {
    const email = `um-test-bdc-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email,
      displayName: 'Test BDC',
      role: 'BDC',
      password: 'testpass123',
      actorUserId,
    })

    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, userId) })
    expect(user?.email).toBe(email)
    expect(user?.role).toBe('BDC')
    expect(user?.displayName).toBe('Test BDC')

    const rep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, userId) })
    expect(rep).toBeUndefined()

    const audit = await db.query.auditEvents.findFirst({
      where: and(eq(schema.auditEvents.entityType, 'app_user'), eq(schema.auditEvents.entityId, userId)),
    })
    expect(audit?.action).toBe('user.create')
  })

  it('creates a REP account with rotation membership rows', async () => {
    const email = `um-test-rep-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email,
      displayName: 'Test Rep',
      role: 'REP',
      password: 'testpass123',
      actorUserId,
    })

    const rep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, userId) })
    expect(rep?.displayName).toBe('Test Rep')

    const today = businessDate(new Date())
    const shift = await db.query.repShift.findFirst({
      where: and(eq(schema.repShift.repId, rep!.id), eq(schema.repShift.businessDate, today)),
    })
    expect(shift?.kind).toBe('WORK')

    const status = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, rep!.id), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(status?.status).toBe('ELIGIBLE')
    expect(status?.decidedBy).toBe('SYSTEM')
  })
})
