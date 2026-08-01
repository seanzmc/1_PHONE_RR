import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { t } from '../trpc/router'
import { authRouter } from './auth'
import { hashPassword, verifyPassword } from '../auth/password'
import {
  checkRecoveryThrottle,
  recordRecoveryRequest,
  resetRecoveryThrottle,
} from '../auth/recoveryThrottle'

const fakeReqRes = { req: {}, res: {} } as any

describe('auth.viewAsProfiles', () => {
  let targetUserId: string

  beforeAll(async () => {
    const [target] = await db
      .insert(schema.appUser)
      .values({
        email: `view-as-temp-${Date.now()}@dealership.test`,
        displayName: 'Real Rep With Temporary Password',
        passwordHash: 'x:y',
        role: 'REP',
        isActive: true,
        mustChangePassword: true,
      })
      .returning()
    targetUserId = target.id
  })

  afterAll(async () => {
    await db.delete(schema.passwordResetToken).where(eq(schema.passwordResetToken.userId, targetUserId))
    await db.delete(schema.appUser).where(eq(schema.appUser.id, targetUserId))
  })

  it('offers every active real profile even before that user completes first sign-in', async () => {
    const caller = t.createCallerFactory(authRouter)({
      session: {
        userId: '00000000-0000-0000-0000-000000000001',
        role: 'ADMIN',
        mustChangePassword: false,
        sessionId: 'view-as-profile-list-test',
      },
      ...fakeReqRes,
    })

    const profiles = await caller.viewAsProfiles()
    expect(profiles.some((profile) => profile.userId === targetUserId)).toBe(true)
  })
})

describe('auth password recovery procedures', () => {
  const registeredEmail = `router-recovery-${Date.now()}@dealership.test`
  let registeredUserId: string

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.appUser)
      .values({
        email: registeredEmail,
        displayName: 'Router Recovery User',
        passwordHash: 'x:y',
        role: 'BDC',
        isActive: true,
      })
      .returning()
    registeredUserId = user.id
  })

  beforeEach(() => resetRecoveryThrottle())

  afterAll(async () => {
    await db.delete(schema.passwordResetToken).where(eq(schema.passwordResetToken.userId, registeredUserId))
    await db.delete(schema.appUser).where(eq(schema.appUser.id, registeredUserId))
  })

  function caller(ip = '203.0.113.7') {
    return t.createCallerFactory(authRouter)({
      session: null,
      req: { ip },
      res: {},
    } as any)
  }

  it('returns the same generic result for registered and unknown email addresses', async () => {
    const registered = await caller().requestPasswordReset({
      email: registeredEmail,
    })
    const unknown = await caller().requestPasswordReset({
      email: `missing-${Date.now()}@dealership.test`,
    })

    expect(registered).toEqual({ ok: true })
    expect(unknown).toEqual({ ok: true })
  })

  it('fails safely when the configured public app URL is invalid', async () => {
    const prior = {
      apiKey: process.env.RESEND_API_KEY,
      from: process.env.RESEND_FROM_EMAIL,
      appBaseUrl: process.env.APP_BASE_URL,
    }
    process.env.RESEND_API_KEY = 'test-api-key'
    process.env.RESEND_FROM_EMAIL = 'PhoneUp <security@example.test>'
    process.env.APP_BASE_URL = 'not a valid URL'

    try {
      await expect(
        caller().requestPasswordReset({ email: registeredEmail }),
      ).resolves.toEqual({ ok: true })
    } finally {
      if (prior.apiKey === undefined) delete process.env.RESEND_API_KEY
      else process.env.RESEND_API_KEY = prior.apiKey
      if (prior.from === undefined) delete process.env.RESEND_FROM_EMAIL
      else process.env.RESEND_FROM_EMAIL = prior.from
      if (prior.appBaseUrl === undefined) delete process.env.APP_BASE_URL
      else process.env.APP_BASE_URL = prior.appBaseUrl
    }
  })

  it('rejects an invalid or expired reset token with a stable public error', async () => {
    await expect(
      caller().completePasswordReset({ token: 'not-a-real-token', newPassword: 'password9' }),
    ).rejects.toMatchObject({ message: 'RESET_LINK_INVALID_OR_EXPIRED' })
  })

  it('throttles repeated requests without disclosing account eligibility', async () => {
    const recoveryCaller = caller('198.51.100.22')
    for (let i = 0; i < 3; i++) {
      await expect(
        recoveryCaller.requestPasswordReset({ email: `unknown-${i}@example.test` }),
      ).resolves.toEqual({ ok: true })
    }

    await expect(
      recoveryCaller.requestPasswordReset({ email: 'another@example.test' }),
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: expect.not.stringMatching(/registered|account|active/i),
    })
  })

  it('validates recovery input before touching account state', async () => {
    await expect(caller().requestPasswordReset({ email: 'not-an-email' })).rejects.toBeDefined()
    await expect(
      caller().completePasswordReset({ token: '', newPassword: 'short' }),
    ).rejects.toBeDefined()
  })
})

describe('auth.changePassword first-login contract', () => {
  let userId: string

  beforeAll(async () => {
    const [user] = await db
      .insert(schema.appUser)
      .values({
        email: `router-change-password-${Date.now()}@dealership.test`,
        displayName: 'Router Password User',
        passwordHash: hashPassword('originalPassword1'),
        role: 'BDC',
      })
      .returning()
    userId = user.id
  })

  beforeEach(async () => {
    await db
      .update(schema.appUser)
      .set({ passwordHash: hashPassword('originalPassword1'), mustChangePassword: false })
      .where(eq(schema.appUser.id, userId))
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.entityId, userId))
  })

  afterAll(async () => {
    await db.delete(schema.session).where(eq(schema.session.userId, userId))
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.entityId, userId))
    await db.delete(schema.appUser).where(eq(schema.appUser.id, userId))
  })

  function caller(mustChangePassword: boolean) {
    return t.createCallerFactory(authRouter)({
      session: {
        userId,
        role: 'BDC',
        mustChangePassword,
        sessionId: `router-password-session-${userId}`,
      },
      req: {},
      res: {},
    } as any)
  }

  it('accepts a new password without the temporary password during forced first login', async () => {
    await db
      .update(schema.appUser)
      .set({ passwordHash: hashPassword('tempPassword8'), mustChangePassword: true })
      .where(eq(schema.appUser.id, userId))

    await expect(caller(true).changePassword({ newPassword: 'chosenPassword9' })).resolves.toEqual({
      ok: true,
    })
    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, userId) })
    expect(verifyPassword('chosenPassword9', user!.passwordHash)).toBe(true)
  })

  it('does not let an ordinary session omit its current password', async () => {
    await expect(caller(false).changePassword({ newPassword: 'chosenPassword9' })).rejects.toMatchObject({
      message: 'CURRENT_PASSWORD_REQUIRED',
    })
  })
})

describe('password recovery throttle', () => {
  beforeEach(() => resetRecoveryThrottle())

  it('allows three requests per email and blocks the fourth for fifteen minutes', () => {
    const keys = ['recovery-email:user@example.test', 'recovery-ip:203.0.113.9']
    for (let i = 0; i < 3; i++) {
      expect(checkRecoveryThrottle(keys, 1_000).throttled).toBe(false)
      recordRecoveryRequest(keys, 1_000)
    }

    expect(checkRecoveryThrottle(keys, 1_000)).toEqual({
      throttled: true,
      retryAfter: 15 * 60,
    })
  })

  it('limits one IP even when it requests different email addresses', () => {
    const ip = 'recovery-ip:198.51.100.4'
    for (let i = 0; i < 3; i++) {
      recordRecoveryRequest([`recovery-email:user${i}@example.test`, ip], 2_000)
    }

    expect(checkRecoveryThrottle([ip], 2_000).throttled).toBe(true)
    expect(
      checkRecoveryThrottle(['recovery-email:fresh@example.test', 'recovery-ip:198.51.100.5'], 2_000)
        .throttled,
    ).toBe(false)
  })
})
