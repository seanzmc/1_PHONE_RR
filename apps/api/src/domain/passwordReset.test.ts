import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { changeOwnPassword, resetPassword } from './userManagement'
import { hashPassword, verifyPassword } from '../auth/password'
import { generateTempPassword } from '@phoneup/core'
import {
  isThrottled,
  recordFailure,
  recordSuccess,
  resetThrottle,
} from '../auth/loginThrottle'

let userId: string
let adminId: string

beforeAll(async () => {
  const admin = await db.query.appUser.findFirst({ where: eq(schema.appUser.role, 'ADMIN') })
  adminId = admin!.id

  const [user] = await db
    .insert(schema.appUser)
    .values({
      email: `pwtest-${Date.now()}@dealership.test`,
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
  await db.delete(schema.session).where(eq(schema.session.userId, userId))
  resetThrottle()
})

async function reload() {
  return db.query.appUser.findFirst({ where: eq(schema.appUser.id, userId) })
}

describe('generateTempPassword', () => {
  it('is short, speakable, and free of ambiguous characters', () => {
    for (let i = 0; i < 200; i++) {
      const pw = generateTempPassword()
      expect(pw).toMatch(/^[a-z]+-[a-z]+-[2-9]{3}$/)
      expect(pw.length).toBeLessThanOrEqual(20)
      // The read-aloud failure modes are digit/letter confusions: 0 vs O and 1 vs l/I.
      // Excluding 0 and 1 from the numeric part removes both, so a letter l inside a
      // dictionary word is unambiguous — nobody mishears "walnut".
      expect(pw).not.toMatch(/[01]/)
      expect(pw).not.toMatch(/[A-Z]/)
      // must satisfy the 8-char minimum the change-password schema enforces
      expect(pw.length).toBeGreaterThanOrEqual(8)
    }
  })

  it('does not repeat trivially', () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTempPassword()))
    expect(seen.size).toBeGreaterThan(150)
  })
})

describe('resetPassword (admin-issued)', () => {
  it('flags mustChangePassword by default and revokes existing sessions', async () => {
    await db.insert(schema.session).values({
      id: `sess-${Date.now()}`,
      userId,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const temp = generateTempPassword()
    await resetPassword(db, { userId, newPassword: temp, actorUserId: adminId })

    const user = await reload()
    expect(user?.mustChangePassword).toBe(true)
    expect(verifyPassword(temp, user!.passwordHash)).toBe(true)

    const sessions = await db.query.session.findMany({ where: eq(schema.session.userId, userId) })
    expect(sessions.length).toBe(0)
  })

  it('can opt out of the flag explicitly', async () => {
    await resetPassword(db, {
      userId,
      newPassword: 'deliberateChoice1',
      actorUserId: adminId,
      mustChangePassword: false,
    })
    expect((await reload())?.mustChangePassword).toBe(false)
  })
})

describe('changeOwnPassword', () => {
  it('clears the forced-change flag when the user picks their own password', async () => {
    await resetPassword(db, { userId, newPassword: 'tempPass123', actorUserId: adminId })
    expect((await reload())?.mustChangePassword).toBe(true)

    await changeOwnPassword(db, {
      userId,
      currentPassword: 'tempPass123',
      newPassword: 'myRealPassword9',
    })

    const user = await reload()
    expect(user?.mustChangePassword).toBe(false)
    expect(verifyPassword('myRealPassword9', user!.passwordHash)).toBe(true)
  })

  it('rejects a wrong current password', async () => {
    await expect(
      changeOwnPassword(db, { userId, currentPassword: 'notThePassword', newPassword: 'whatever12' }),
    ).rejects.toThrow(/current password is incorrect/)
    // and the stored password is untouched
    expect(verifyPassword('originalPassword1', (await reload())!.passwordHash)).toBe(true)
  })

  it('refuses reusing the same password, which would leave a temp password in place', async () => {
    await expect(
      changeOwnPassword(db, {
        userId,
        currentPassword: 'originalPassword1',
        newPassword: 'originalPassword1',
      }),
    ).rejects.toThrow(/must be different/)
  })

  it('keeps the calling session but revokes the others', async () => {
    const keep = `keep-${Date.now()}`
    const other = `other-${Date.now()}`
    await db.insert(schema.session).values([
      { id: keep, userId, expiresAt: new Date(Date.now() + 60_000) },
      { id: other, userId, expiresAt: new Date(Date.now() + 60_000) },
    ])

    await changeOwnPassword(db, {
      userId,
      currentPassword: 'originalPassword1',
      newPassword: 'brandNewPass7',
      keepSessionId: keep,
    })

    const sessions = await db.query.session.findMany({ where: eq(schema.session.userId, userId) })
    expect(sessions.map((s: any) => s.id)).toEqual([keep])
  })

  it('audit-logs the change', async () => {
    await changeOwnPassword(db, {
      userId,
      currentPassword: 'originalPassword1',
      newPassword: 'auditedPass5',
    })
    const events = await db.query.auditEvents.findMany({
      where: eq(schema.auditEvents.action, 'user.changeOwnPassword'),
    })
    expect(events.some((e: any) => e.entityId === userId)).toBe(true)
  })
})

describe('login throttle', () => {
  it('locks out after repeated failures and reports a retry window', () => {
    const keys = ['email:victim@example.test', 'ip:203.0.113.9']
    for (let i = 0; i < 8; i++) {
      expect(isThrottled(keys).throttled).toBe(false)
      recordFailure(keys)
    }
    const state = isThrottled(keys)
    expect(state.throttled).toBe(true)
    expect(state.retryAfter).toBeGreaterThan(0)
  })

  it('a successful login clears the counter', () => {
    const keys = ['email:ok@example.test']
    for (let i = 0; i < 3; i++) recordFailure(keys)
    recordSuccess(keys)
    for (let i = 0; i < 7; i++) recordFailure(keys)
    // counter restarted, so 7 more failures is still under the limit
    expect(isThrottled(keys).throttled).toBe(false)
  })

  it('throttles by IP even across different emails — blocks spraying one host', () => {
    const ip = 'ip:198.51.100.4'
    for (let i = 0; i < 8; i++) recordFailure([`email:user${i}@example.test`, ip])
    expect(isThrottled([ip]).throttled).toBe(true)
    // a fresh email from a clean IP is unaffected
    expect(isThrottled(['email:innocent@example.test', 'ip:198.51.100.5']).throttled).toBe(false)
  })

  it('makes the short temp-password keyspace impractical to sweep online', () => {
    // 8 attempts then a 15-minute lockout: an attacker gets ~32 guesses/hour against
    // a ~40k+ keyspace, so the shortness is covered by throttling, not by luck.
    const keys = ['email:target@example.test']
    let allowed = 0
    for (let i = 0; i < 50; i++) {
      if (!isThrottled(keys).throttled) {
        allowed++
        recordFailure(keys)
      }
    }
    expect(allowed).toBe(8)
  })
})
