import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { setProtected, deleteUserForce } from './protectedAccount.testutil'
import {
  createAccount,
  setRole,
  setActive,
  resetPassword,
  changeOwnPassword,
  PROTECTED_ACCOUNT_ERROR,
} from './userManagement'
import {
  completePasswordReset,
  hashResetToken,
  RESET_TOKEN_TTL_MS,
} from './passwordRecovery'

describe('protected account — domain guards', () => {
  let protectedUserId: string
  let actorUserId: string
  let sacrificialAdminId: string

  beforeAll(async () => {
    const stamp = Date.now()
    // A second active ADMIN so the "last active ADMIN" guards never fire first and mask
    // the protection rejection we are actually testing.
    const sacrificial = await createAccount(db, {
      email: `guard-admin-${stamp}@test.local`,
      displayName: 'Guard Admin',
      role: 'ADMIN',
      password: 'temp-password-234',
      actorUserId: '00000000-0000-0000-0000-000000000000',
    })
    sacrificialAdminId = sacrificial.userId
    actorUserId = sacrificial.userId

    const owner = await createAccount(db, {
      email: `guard-owner-${stamp}@test.local`,
      displayName: 'Guard Owner',
      role: 'ADMIN',
      password: 'temp-password-235',
      actorUserId: sacrificial.userId,
    })
    protectedUserId = owner.userId
    await setProtected(protectedUserId, true)
  })

  afterAll(async () => {
    // The forgot-password test below inserts a passwordResetToken row for protectedUserId.
    // That row has a plain FK to app_user (no cascade), so deleteUserForce's DELETE FROM
    // app_user would violate it unless the token row is cleared first.
    //
    // Each step is wrapped so a failure in one still lets the later ones run — the trigger
    // blocks DELETE on a protected row outright, so a partially-run cleanup here is exactly
    // how a protected fixture poisons every later run against this database.
    try {
      await db.delete(schema.passwordResetToken).where(eq(schema.passwordResetToken.userId, protectedUserId))
    } finally {
      try {
        await deleteUserForce(protectedUserId)
      } finally {
        await deleteUserForce(sacrificialAdminId)
      }
    }
  })

  async function deniedRowCount(): Promise<number> {
    const rows = await db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityId, protectedUserId),
          eq(schema.auditEvents.action, 'user.protectedWriteDenied'),
        ),
      )
    return rows.length
  }

  it('rejects setRole against a protected account', async () => {
    await expect(
      setRole(db, { userId: protectedUserId, newRole: 'REP', actorUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
  })

  it('rejects setActive against a protected account', async () => {
    await expect(
      setActive(db, { userId: protectedUserId, isActive: false, actorUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
  })

  it('rejects resetPassword against a protected account', async () => {
    await expect(
      resetPassword(db, { userId: protectedUserId, newPassword: 'nope-nope-234', actorUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
  })

  it('rejects the protected account acting on itself', async () => {
    await expect(
      setRole(db, { userId: protectedUserId, newRole: 'MANAGER', actorUserId: protectedUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
  })

  it('writes one denied audit row per rejected attempt, and the row survives the rejection', async () => {
    const before = await deniedRowCount()
    await expect(
      setActive(db, { userId: protectedUserId, isActive: false, actorUserId }),
    ).rejects.toThrow(PROTECTED_ACCOUNT_ERROR)
    expect(await deniedRowCount()).toBe(before + 1)

    const [latest] = await db
      .select()
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.entityId, protectedUserId),
          eq(schema.auditEvents.action, 'user.protectedWriteDenied'),
        ),
      )
      .orderBy(desc(schema.auditEvents.createdAt))
      .limit(1)
    expect(latest.actorUserId).toBe(actorUserId)
  })

  it('leaves the protected account untouched after a rejected attempt', async () => {
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.role).toBe('ADMIN')
    expect(row?.isActive).toBe(true)
  })

  it('allows the protected account to change its own password', async () => {
    await changeOwnPassword(db, {
      userId: protectedUserId,
      currentPassword: 'temp-password-235',
      newPassword: 'chosen-password-236',
    })
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.mustChangePassword).toBe(false)
  })

  it('allows resetPassword with allowProtected, for recover-admin', async () => {
    await resetPassword(db, {
      userId: protectedUserId,
      newPassword: 'recovered-password-237',
      actorUserId: protectedUserId,
      allowProtected: true,
    })
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.mustChangePassword).toBe(true)
  })

  it('allows setActive with allowProtected, for recover-admin', async () => {
    // Flip in both directions and assert the state actually changed each time. The
    // protected row starts active, so an allowProtected call that only re-asserts "true"
    // is a no-op the trigger would happily permit even without the GUC escape hatch wired
    // up correctly — it would prove nothing about the real flip.
    await setActive(db, {
      userId: protectedUserId,
      isActive: false,
      actorUserId,
      allowProtected: true,
    })
    const deactivated = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(deactivated?.isActive).toBe(false)

    await setActive(db, {
      userId: protectedUserId,
      isActive: true,
      actorUserId,
      allowProtected: true,
    })
    const reactivated = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(reactivated?.isActive).toBe(true)
  })

  it('leaves unprotected accounts writable', async () => {
    await setActive(db, { userId: sacrificialAdminId, isActive: true, actorUserId })
    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, sacrificialAdminId) })
    expect(row?.isActive).toBe(true)
  })

  // The forgot-password flow writes only password_hash and must_change_password, never calls
  // resetPassword, and must keep working for the protected account — it is the account's
  // self-service recovery when the mailbox is reachable.
  it('allows the forgot-password flow to complete against a protected account', async () => {
    const token = 'protected-account-reset-token-fixture'
    await db.insert(schema.passwordResetToken).values({
      userId: protectedUserId,
      tokenHash: hashResetToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    })

    await completePasswordReset(db, { token, newPassword: 'self-service-238' })

    const row = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, protectedUserId) })
    expect(row?.mustChangePassword).toBe(false)
  })

  // The last-active-ADMIN guards must still count the protected admin. If they skipped it, a
  // visible ADMIN could be demoted into what looks like a zero-admin state.
  it('counts the protected admin when guarding the last active ADMIN', async () => {
    await setActive(db, {
      userId: protectedUserId,
      isActive: true,
      actorUserId: protectedUserId,
      allowProtected: true,
    })

    // The seeded ADMIN is active too, so without this the guard would pass whether or not it
    // counted the protected admin — the assertion would prove nothing. Park every other
    // active ADMIN so the protected one is the only thing standing between the sacrificial
    // admin and a zero-admin state.
    const activeAdmins = await db
      .select()
      .from(schema.appUser)
      .where(and(eq(schema.appUser.role, 'ADMIN'), eq(schema.appUser.isActive, true)))
    const parked = activeAdmins.filter(
      (u: any) => u.id !== protectedUserId && u.id !== sacrificialAdminId,
    )

    for (const u of parked) {
      await db.update(schema.appUser).set({ isActive: false }).where(eq(schema.appUser.id, u.id))
    }
    try {
      await expect(
        setActive(db, { userId: sacrificialAdminId, isActive: false, actorUserId: protectedUserId }),
      ).resolves.toBeUndefined()
    } finally {
      for (const u of parked) {
        await db.update(schema.appUser).set({ isActive: true }).where(eq(schema.appUser.id, u.id))
      }
      await setActive(db, {
        userId: sacrificialAdminId,
        isActive: true,
        actorUserId: protectedUserId,
      })
    }
  })
})
