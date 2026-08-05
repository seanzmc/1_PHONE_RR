import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inArray, sql } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { createSession } from '../auth/session'
import { createContext } from './context'
import { createAccount } from '../domain/userManagement'
import { setProtected, deleteUserForce } from '../domain/protectedAccount.testutil'

function request(sessionId: string, targetUserId: string, method = 'GET') {
  return {
    req: {
      cookies: { sid: sessionId },
      headers: { 'x-phoneup-view-as': targetUserId },
      method,
    },
    res: {},
  } as any
}

describe('view-as context', () => {
  const userIds: string[] = []
  const sessionIds: string[] = []
  let adminSessionId: string
  let managerSessionId: string
  let targetUserId: string
  let temporaryPasswordTargetId: string
  let inactiveTargetId: string

  beforeAll(async () => {
    async function user(
      label: string,
      role: 'ADMIN' | 'MANAGER' | 'REP',
      isActive = true,
      mustChangePassword = false,
    ) {
      const [row] = await db
        .insert(schema.appUser)
        .values({
          email: `view-as-${label}-${Date.now()}@dealership.test`,
          displayName: `View As ${label}`,
          passwordHash: 'x:y',
          role,
          isActive,
          mustChangePassword,
        })
        .returning()
      userIds.push(row.id)
      return row
    }

    const admin = await user('admin', 'ADMIN')
    const manager = await user('manager', 'MANAGER')
    const target = await user('target', 'REP')
    const temporaryPasswordTarget = await user('temporary-password', 'REP', true, true)
    const inactive = await user('inactive', 'REP', false)
    targetUserId = target.id
    temporaryPasswordTargetId = temporaryPasswordTarget.id
    inactiveTargetId = inactive.id

    const adminSession = await createSession(admin.id)
    const managerSession = await createSession(manager.id)
    adminSessionId = adminSession.id
    managerSessionId = managerSession.id
    sessionIds.push(adminSession.id, managerSession.id)
  })

  afterAll(async () => {
    await db.delete(schema.session).where(inArray(schema.session.id, sessionIds))
    await db.delete(schema.appUser).where(inArray(schema.appUser.id, userIds))
  })

  it('resolves an active real target and applies that target identity and role to GET queries', async () => {
    const context = await createContext(request(adminSessionId, targetUserId))
    expect(context.session).toMatchObject({ userId: targetUserId, role: 'REP' })
    expect(context.viewAs).toMatchObject({ targetUserId })
  })

  it('allows an admin to inspect an active real profile that has not completed first sign-in', async () => {
    const context = await createContext(request(adminSessionId, temporaryPasswordTargetId))
    expect(context.session).toMatchObject({
      userId: temporaryPasswordTargetId,
      role: 'REP',
      mustChangePassword: false,
    })
  })

  it('rejects a non-admin attempting to spoof the header', async () => {
    await expect(createContext(request(managerSessionId, targetUserId))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects all mutations while view-as is active', async () => {
    await expect(createContext(request(adminSessionId, targetUserId, 'POST'))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects an inactive target profile', async () => {
    await expect(createContext(request(adminSessionId, inactiveTargetId))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('view-as context — protected account', () => {
  let protectedUserId: string
  let plainAdminId: string
  let plainAdminSessionId: string
  const sessionIds: string[] = []

  beforeAll(async () => {
    // Self-healing: clear any leftover protected fixture from a killed prior run before
    // creating fresh ones — an ordinary DELETE cannot touch a protected row, so a stale one
    // would otherwise poison every later run of this suite.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local app.protected_write = 'on'`)
      await tx.execute(sql`delete from app_user where email like 'view-as-ctx-protected-%@test.local'`)
    })

    const stamp = Date.now()
    const plain = await createAccount(db, {
      email: `view-as-ctx-protected-admin-${stamp}@test.local`,
      displayName: 'View As Ctx Plain Admin',
      role: 'ADMIN',
      password: 'temp-password-534',
      actorUserId: '00000000-0000-0000-0000-000000000000',
    })
    plainAdminId = plain.userId

    const owner = await createAccount(db, {
      email: `view-as-ctx-protected-owner-${stamp}@test.local`,
      displayName: 'View As Ctx Owner',
      role: 'ADMIN',
      password: 'temp-password-535',
      actorUserId: plain.userId,
    })
    protectedUserId = owner.userId
    await setProtected(protectedUserId, true)

    const plainAdminSession = await createSession(plainAdminId)
    plainAdminSessionId = plainAdminSession.id
    sessionIds.push(plainAdminSession.id)
  })

  afterAll(async () => {
    await db.delete(schema.session).where(inArray(schema.session.id, sessionIds))
    // Wrapped so a failure in one delete does not skip the other — the trigger blocks
    // DELETE on a protected row outright, so a partially-run cleanup here is exactly how a
    // protected fixture poisons every later run against this database.
    try {
      await deleteUserForce(protectedUserId)
    } finally {
      await deleteUserForce(plainAdminId)
    }
  })

  it('rejects an ADMIN attempting to view-as the protected account via the header', async () => {
    await expect(createContext(request(plainAdminSessionId, protectedUserId))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
