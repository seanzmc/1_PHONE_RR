import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { t } from '../trpc/router'
import { authRouter } from './auth'

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
