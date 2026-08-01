import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, getTableColumns, isNull } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { hashPassword, verifyPassword } from '../auth/password'
import {
  completePasswordReset,
  hashResetToken,
  requestPasswordReset,
  RESET_TOKEN_TTL_MS,
} from './passwordRecovery'

describe('password reset token schema', () => {
  it('stores only a token digest with expiry and consumption timestamps', () => {
    const columns = getTableColumns(schema.passwordResetToken)

    expect(Object.keys(columns)).toEqual([
      'id',
      'userId',
      'tokenHash',
      'expiresAt',
      'usedAt',
      'createdAt',
    ])
    expect('token' in columns).toBe(false)
  })
})

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`
const activeEmail = `recovery-active-${stamp}@dealership.test`
const inactiveEmail = `recovery-inactive-${stamp}@dealership.test`
let activeUserId: string
let inactiveUserId: string

const now = new Date('2026-08-01T17:00:00.000Z')
const fixedToken = 'fixed-secret-token-with-enough-entropy-for-tests'
const sendEmail = vi.fn(async () => {})
const logDeliveryFailure = vi.fn()

beforeAll(async () => {
  const [active, inactive] = await db
    .insert(schema.appUser)
    .values([
      {
        email: activeEmail,
        displayName: 'Active Recovery User',
        passwordHash: hashPassword('originalPassword1'),
        role: 'BDC',
        isActive: true,
        mustChangePassword: true,
      },
      {
        email: inactiveEmail,
        displayName: 'Inactive Recovery User',
        passwordHash: hashPassword('originalPassword1'),
        role: 'BDC',
        isActive: false,
      },
    ])
    .returning()
  activeUserId = active.id
  inactiveUserId = inactive.id
})

beforeEach(async () => {
  sendEmail.mockClear()
  sendEmail.mockResolvedValue(undefined)
  logDeliveryFailure.mockClear()
  await db.delete(schema.passwordResetToken).where(eq(schema.passwordResetToken.userId, activeUserId))
  await db.delete(schema.passwordResetToken).where(eq(schema.passwordResetToken.userId, inactiveUserId))
  await db.delete(schema.session).where(eq(schema.session.userId, activeUserId))
  await db.delete(schema.auditEvents).where(eq(schema.auditEvents.entityId, activeUserId))
  await db
    .update(schema.appUser)
    .set({
      passwordHash: hashPassword('originalPassword1'),
      isActive: true,
      mustChangePassword: true,
    })
    .where(eq(schema.appUser.id, activeUserId))
  await db.update(schema.appUser).set({ isActive: false }).where(eq(schema.appUser.id, inactiveUserId))
})

afterAll(async () => {
  await db.delete(schema.passwordResetToken).where(eq(schema.passwordResetToken.userId, activeUserId))
  await db.delete(schema.passwordResetToken).where(eq(schema.passwordResetToken.userId, inactiveUserId))
  await db.delete(schema.session).where(eq(schema.session.userId, activeUserId))
  await db.delete(schema.auditEvents).where(eq(schema.auditEvents.entityId, activeUserId))
  await db.delete(schema.appUser).where(eq(schema.appUser.id, activeUserId))
  await db.delete(schema.appUser).where(eq(schema.appUser.id, inactiveUserId))
})

function deps() {
  return {
    sendEmail,
    appBaseUrl: 'https://phoneup.example/',
    now: () => now,
    randomToken: () => fixedToken,
    logDeliveryFailure,
  }
}

async function reloadActiveUser() {
  return db.query.appUser.findFirst({ where: eq(schema.appUser.id, activeUserId) })
}

describe('requestPasswordReset', () => {
  it('emails only the stored address of an active matching account', async () => {
    await requestPasswordReset(db, { email: `  ${activeEmail.toUpperCase()}  ` }, deps())

    expect(sendEmail).toHaveBeenCalledWith({
      to: activeEmail,
      displayName: 'Active Recovery User',
      resetUrl: `https://phoneup.example/?reset_token=${encodeURIComponent(fixedToken)}`,
      expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
    })
    const rows = await db.query.passwordResetToken.findMany({
      where: eq(schema.passwordResetToken.userId, activeUserId),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].tokenHash).toBe(hashResetToken(fixedToken))
    expect(JSON.stringify(rows[0])).not.toContain(fixedToken)
  })

  it.each([
    ['unknown', `recovery-unknown-${stamp}@dealership.test`],
    ['inactive', inactiveEmail],
  ])('returns silently and sends nothing for an %s email', async (_label, email) => {
    await requestPasswordReset(db, { email }, deps())

    expect(sendEmail).not.toHaveBeenCalled()
    const rows = await db.select().from(schema.passwordResetToken)
    expect(rows.some((row) => row.userId === inactiveUserId)).toBe(false)
  })

  it('invalidates the new token and reports a sanitized delivery failure', async () => {
    sendEmail.mockRejectedValueOnce(new Error('Resend email request failed (503)'))

    await requestPasswordReset(db, { email: activeEmail }, deps())

    const [row] = await db
      .select()
      .from(schema.passwordResetToken)
      .where(eq(schema.passwordResetToken.userId, activeUserId))
    expect(row.usedAt).toEqual(now)
    expect(logDeliveryFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Resend email request failed (503)' }),
    )
  })
})

describe('completePasswordReset', () => {
  it('changes the password and consumes every outstanding credential for the account', async () => {
    await requestPasswordReset(db, { email: activeEmail }, deps())
    await db.insert(schema.passwordResetToken).values({
      userId: activeUserId,
      tokenHash: hashResetToken('another-outstanding-token'),
      expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
    })
    await db.insert(schema.session).values([
      { id: `recovery-a-${stamp}`, userId: activeUserId, expiresAt: new Date(now.getTime() + 60_000) },
      { id: `recovery-b-${stamp}`, userId: activeUserId, expiresAt: new Date(now.getTime() + 60_000) },
    ])

    await completePasswordReset(
      db,
      { token: fixedToken, newPassword: 'newPassword9' },
      now,
    )

    const user = await reloadActiveUser()
    expect(verifyPassword('newPassword9', user!.passwordHash)).toBe(true)
    expect(user!.mustChangePassword).toBe(false)
    expect(
      await db.query.session.findMany({ where: eq(schema.session.userId, activeUserId) }),
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(schema.passwordResetToken)
        .where(
          and(
            eq(schema.passwordResetToken.userId, activeUserId),
            isNull(schema.passwordResetToken.usedAt),
          ),
        ),
    ).toHaveLength(0)
    const audit = await db.query.auditEvents.findMany({
      where: and(
        eq(schema.auditEvents.entityId, activeUserId),
        eq(schema.auditEvents.action, 'user.resetOwnPassword'),
      ),
    })
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit[0])).not.toContain(fixedToken)
    expect(audit[0].after).toEqual({ source: 'self_service', mustChangePassword: false })
  })

  it.each([
    ['unknown', 'not-a-real-token', new Date(now.getTime() + RESET_TOKEN_TTL_MS), null],
    ['expired', fixedToken, new Date(now.getTime() - 1), null],
    ['used', fixedToken, new Date(now.getTime() + RESET_TOKEN_TTL_MS), now],
  ])('rejects an %s token without changing the account', async (_label, token, expiresAt, usedAt) => {
    if (token === fixedToken) {
      await db.insert(schema.passwordResetToken).values({
        userId: activeUserId,
        tokenHash: hashResetToken(fixedToken),
        expiresAt,
        usedAt,
      })
    }

    await expect(
      completePasswordReset(db, { token, newPassword: 'newPassword9' }, now),
    ).rejects.toThrow('RESET_LINK_INVALID_OR_EXPIRED')
    expect(verifyPassword('originalPassword1', (await reloadActiveUser())!.passwordHash)).toBe(true)
  })

  it('rejects a link after the linked account is deactivated', async () => {
    await requestPasswordReset(db, { email: activeEmail }, deps())
    await db.update(schema.appUser).set({ isActive: false }).where(eq(schema.appUser.id, activeUserId))

    await expect(
      completePasswordReset(db, { token: fixedToken, newPassword: 'newPassword9' }, now),
    ).rejects.toThrow('RESET_LINK_INVALID_OR_EXPIRED')
    expect(verifyPassword('originalPassword1', (await reloadActiveUser())!.passwordHash)).toBe(true)
  })

  it('cannot reuse a successfully consumed link', async () => {
    await requestPasswordReset(db, { email: activeEmail }, deps())
    await completePasswordReset(db, { token: fixedToken, newPassword: 'newPassword9' }, now)

    await expect(
      completePasswordReset(db, { token: fixedToken, newPassword: 'thirdPassword8' }, now),
    ).rejects.toThrow('RESET_LINK_INVALID_OR_EXPIRED')
  })
})
