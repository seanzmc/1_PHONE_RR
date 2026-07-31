import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inArray } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { createSession } from '../auth/session'
import { createContext } from './context'

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
