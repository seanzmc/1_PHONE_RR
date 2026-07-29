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

import { setRole } from './userManagement'

describe('setRole', () => {
  it('REP -> BDC pulls the rep out of rotation for today', async () => {
    const email = `um-test-setrole-a-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Role Test A', role: 'REP', password: 'testpass123', actorUserId,
    })
    const rep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, userId) })

    await setRole(db, { userId, newRole: 'BDC', actorUserId })

    const today = businessDate(new Date())
    const status = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, rep!.id), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(status?.status).toBe('INELIGIBLE')
    expect(status?.decidedBy).toBe('MANAGER_OVERRIDE')
    expect(status?.reason).toMatch(/role changed to BDC/)

    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, userId) })
    expect(user?.role).toBe('BDC')
  })

  it('BDC -> REP creates rotation membership', async () => {
    const email = `um-test-setrole-b-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Role Test B', role: 'BDC', password: 'testpass123', actorUserId,
    })

    await setRole(db, { userId, newRole: 'REP', actorUserId })

    const rep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, userId) })
    expect(rep?.displayName).toBe('Role Test B')

    const today = businessDate(new Date())
    const status = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, rep!.id), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(status?.status).toBe('ELIGIBLE')
    expect(status?.decidedBy).toBe('MANAGER_OVERRIDE')
  })

  it('REP -> BDC -> REP reuses the existing sales_rep row (rehire case)', async () => {
    const email = `um-test-setrole-c-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Role Test C', role: 'REP', password: 'testpass123', actorUserId,
    })
    const originalRep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, userId) })

    await setRole(db, { userId, newRole: 'BDC', actorUserId })
    await setRole(db, { userId, newRole: 'REP', actorUserId })

    const reps = await db.select().from(schema.salesRep).where(eq(schema.salesRep.userId, userId))
    expect(reps).toHaveLength(1)
    expect(reps[0].id).toBe(originalRep!.id)
    expect(reps[0].hireDate).toBe(originalRep!.hireDate)
  })

  it('deactivated account changed to REP lands INELIGIBLE, not ELIGIBLE', async () => {
    const email = `um-test-setrole-inactive-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Role Test Inactive', role: 'BDC', password: 'testpass123', actorUserId,
    })

    await setActive(db, { userId, isActive: false, actorUserId })
    await setRole(db, { userId, newRole: 'REP', actorUserId })

    const rep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, userId) })
    const today = businessDate(new Date())
    const status = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, rep!.id), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(status?.status).toBe('INELIGIBLE')
  })

  it('refuses to change the last active ADMIN to a non-ADMIN role', async () => {
    const allAdmins = await db.select().from(schema.appUser).where(eq(schema.appUser.role, 'ADMIN'))
    const activeAdmins = allAdmins.filter((a) => a.isActive)
    const [survivor, ...rest] = activeAdmins

    for (const admin of rest) {
      await db.update(schema.appUser).set({ isActive: false }).where(eq(schema.appUser.id, admin.id))
    }

    try {
      await expect(
        setRole(db, { userId: survivor.id, newRole: 'MANAGER', actorUserId: survivor.id }),
      ).rejects.toThrow(/last active ADMIN/)
    } finally {
      for (const admin of rest) {
        await db.update(schema.appUser).set({ isActive: true }).where(eq(schema.appUser.id, admin.id))
      }
    }
  })
})

import { setActive } from './userManagement'

describe('setActive', () => {
  it('deactivates and reactivates an account', async () => {
    const email = `um-test-setactive-a-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Active Test A', role: 'BDC', password: 'testpass123', actorUserId,
    })

    await setActive(db, { userId, isActive: false, actorUserId })
    let user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, userId) })
    expect(user?.isActive).toBe(false)

    await setActive(db, { userId, isActive: true, actorUserId })
    user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, userId) })
    expect(user?.isActive).toBe(true)
  })

  it('deactivating a REP also marks them INELIGIBLE for today, reactivating marks ELIGIBLE', async () => {
    const email = `um-test-setactive-b-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Active Test B', role: 'REP', password: 'testpass123', actorUserId,
    })
    const rep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, userId) })
    const today = businessDate(new Date())

    await setActive(db, { userId, isActive: false, actorUserId })
    let status = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, rep!.id), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(status?.status).toBe('INELIGIBLE')
    expect(status?.decidedBy).toBe('MANAGER_OVERRIDE')

    await setActive(db, { userId, isActive: true, actorUserId })
    status = await db.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, rep!.id), eq(schema.repDailyStatus.businessDate, today)),
    })
    expect(status?.status).toBe('ELIGIBLE')
  })

  it('refuses self-deactivation', async () => {
    const email = `um-test-setactive-c-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Active Test C', role: 'BDC', password: 'testpass123', actorUserId,
    })

    await expect(
      setActive(db, { userId, isActive: false, actorUserId: userId }),
    ).rejects.toThrow(/own account/)
  })

  it('refuses to deactivate the last active ADMIN', async () => {
    const allAdmins = await db.select().from(schema.appUser).where(eq(schema.appUser.role, 'ADMIN'))
    const activeAdmins = allAdmins.filter((a) => a.isActive)
    const [survivor, ...rest] = activeAdmins

    for (const admin of rest) {
      await db.update(schema.appUser).set({ isActive: false }).where(eq(schema.appUser.id, admin.id))
    }

    const otherActor = rest[0] ?? survivor
    try {
      await expect(
        setActive(db, { userId: survivor.id, isActive: false, actorUserId: otherActor.id }),
      ).rejects.toThrow(/last active ADMIN/)
    } finally {
      for (const admin of rest) {
        await db.update(schema.appUser).set({ isActive: true }).where(eq(schema.appUser.id, admin.id))
      }
    }
  })
})

import { resetPassword } from './userManagement'
import { verifyPassword } from '../auth/password'

describe('resetPassword', () => {
  it('replaces the password hash so only the new password verifies', async () => {
    const email = `um-test-resetpw-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Reset Test', role: 'BDC', password: 'oldpass123', actorUserId,
    })

    await resetPassword(db, { userId, newPassword: 'newpass456', actorUserId })

    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, userId) })
    expect(verifyPassword('newpass456', user!.passwordHash)).toBe(true)
    expect(verifyPassword('oldpass123', user!.passwordHash)).toBe(false)
  })

  it('logs an audit event without the password value', async () => {
    const email = `um-test-resetpw-audit-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Reset Audit Test', role: 'BDC', password: 'oldpass123', actorUserId,
    })

    await resetPassword(db, { userId, newPassword: 'supersecretnew789', actorUserId })

    const audit = await db.query.auditEvents.findFirst({
      where: and(eq(schema.auditEvents.entityType, 'app_user'), eq(schema.auditEvents.entityId, userId), eq(schema.auditEvents.action, 'user.resetPassword')),
    })
    expect(audit?.action).toBe('user.resetPassword')
    expect(JSON.stringify(audit?.after)).not.toContain('supersecretnew789')
    expect(JSON.stringify(audit?.before)).not.toContain('oldpass123')
  })

  it('invalidates existing sessions for the account', async () => {
    const email = `um-test-resetpw-session-${Date.now()}@dealership.test`
    const { userId } = await createAccount(db, {
      email, displayName: 'Reset Session Test', role: 'BDC', password: 'oldpass123', actorUserId,
    })

    await db.insert(schema.session).values({
      id: `test-session-${Date.now()}`,
      userId,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 12),
    })

    await resetPassword(db, { userId, newPassword: 'newpass456', actorUserId })

    const session = await db.query.session.findFirst({ where: eq(schema.session.userId, userId) })
    expect(session).toBeUndefined()
  })
})
