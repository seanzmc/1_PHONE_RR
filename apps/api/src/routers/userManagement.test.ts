import { describe, it, expect, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { t } from '../trpc/router'
import { userManagementRouter } from './userManagement'
import type { Context } from '../trpc/context'
import type { Role } from '@phoneup/contracts'
import { createAccount } from '../domain/userManagement'

const fakeReqRes = { req: {} as Context['req'], res: {} as Context['res'] }

/**
 * A complete session, so these callers exercise the same shape the real context builds —
 * a partial literal here type-errored and let the password-change gate go untested.
 */
function fakeSession(userId: string, role: Role): NonNullable<Context['session']> {
  return { userId, role, mustChangePassword: false, sessionId: `test-session-${userId}` }
}

describe('userManagementRouter', () => {
  it('rejects BDC', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession('u1', 'BDC'),
      ...fakeReqRes,
    })
    await expect(caller.list()).rejects.toThrow(/FORBIDDEN/)
  })

  it('rejects REP', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession('u1', 'REP'),
      ...fakeReqRes,
    })
    await expect(caller.list()).rejects.toThrow(/FORBIDDEN/)
  })

  it('allows MANAGER to list accounts', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession('u1', 'MANAGER'),
      ...fakeReqRes,
    })
    await expect(caller.list()).resolves.toBeInstanceOf(Array)
  })

  it('allows ADMIN to list accounts', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: fakeSession('u1', 'ADMIN'),
      ...fakeReqRes,
    })
    await expect(caller.list()).resolves.toBeInstanceOf(Array)
  })
})

describe('userManagementRouter — ADMIN-gating on setRole/resetPassword', () => {
  let actorUserId: string // real ADMIN account, doubles as the ADMIN caller's session.userId

  let adminTargetForManagerReject: string
  let bdcTargetForManagerReject: string
  let bdcTargetForAdminGrant: string
  let adminTargetForAdminSetRole: string
  let adminTargetForAdminResetPw: string

  beforeAll(async () => {
    const [actor] = await db
      .insert(schema.appUser)
      .values({ email: `um-router-test-actor-${Date.now()}@dealership.test`, passwordHash: 'x:y', role: 'ADMIN' })
      .returning()
    actorUserId = actor.id

    ;({ userId: adminTargetForManagerReject } = await createAccount(db, {
      email: `um-router-test-admin-a-${Date.now()}@dealership.test`,
      displayName: 'Admin Target A', role: 'ADMIN', password: 'testpass123', actorUserId,
    }))
    ;({ userId: bdcTargetForManagerReject } = await createAccount(db, {
      email: `um-router-test-bdc-a-${Date.now()}@dealership.test`,
      displayName: 'BDC Target A', role: 'BDC', password: 'testpass123', actorUserId,
    }))
    ;({ userId: bdcTargetForAdminGrant } = await createAccount(db, {
      email: `um-router-test-bdc-b-${Date.now()}@dealership.test`,
      displayName: 'BDC Target B', role: 'BDC', password: 'testpass123', actorUserId,
    }))
    ;({ userId: adminTargetForAdminSetRole } = await createAccount(db, {
      email: `um-router-test-admin-b-${Date.now()}@dealership.test`,
      displayName: 'Admin Target B', role: 'ADMIN', password: 'testpass123', actorUserId,
    }))
    ;({ userId: adminTargetForAdminResetPw } = await createAccount(db, {
      email: `um-router-test-admin-c-${Date.now()}@dealership.test`,
      displayName: 'Admin Target C', role: 'ADMIN', password: 'testpass123', actorUserId,
    }))
  })

  function managerCaller() {
    return t.createCallerFactory(userManagementRouter)({
      session: fakeSession('manager-1', 'MANAGER'),
      ...fakeReqRes,
    })
  }

  function adminCaller() {
    return t.createCallerFactory(userManagementRouter)({
      session: fakeSession(actorUserId, 'ADMIN'),
      ...fakeReqRes,
    })
  }

  it('MANAGER cannot promote an account to ADMIN via setRole', async () => {
    await expect(
      managerCaller().setRole({ userId: bdcTargetForManagerReject, newRole: 'ADMIN' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, bdcTargetForManagerReject) })
    expect(user?.role).toBe('BDC')
  })

  it('MANAGER cannot change the role of an account whose current role is ADMIN', async () => {
    await expect(
      managerCaller().setRole({ userId: adminTargetForManagerReject, newRole: 'MANAGER' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, adminTargetForManagerReject) })
    expect(user?.role).toBe('ADMIN')
  })

  it('MANAGER cannot resetPassword on an ADMIN-role target', async () => {
    await expect(
      managerCaller().resetPassword({ userId: adminTargetForManagerReject, newPassword: 'newpass456' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('ADMIN caller can grant the ADMIN role via setRole', async () => {
    await expect(
      adminCaller().setRole({ userId: bdcTargetForAdminGrant, newRole: 'ADMIN' }),
    ).resolves.toEqual({ ok: true })

    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, bdcTargetForAdminGrant) })
    expect(user?.role).toBe('ADMIN')
  })

  it('ADMIN caller can change the role of an account whose current role is ADMIN', async () => {
    await expect(
      adminCaller().setRole({ userId: adminTargetForAdminSetRole, newRole: 'MANAGER' }),
    ).resolves.toEqual({ ok: true })

    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, adminTargetForAdminSetRole) })
    expect(user?.role).toBe('MANAGER')
  })

  it('ADMIN caller can resetPassword on an ADMIN-role target', async () => {
    await expect(
      adminCaller().resetPassword({ userId: adminTargetForAdminResetPw, newPassword: 'newpass456' }),
    ).resolves.toEqual({ ok: true })
  })
})
