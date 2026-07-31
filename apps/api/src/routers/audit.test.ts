import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { t } from '../trpc/router'
import { auditRouter } from './audit'

const fakeReqRes = { req: {}, res: {} } as any
const caller = (role: 'ADMIN' | 'MANAGER' | 'BDC' | 'REP') => t.createCallerFactory(auditRouter)({
  session: { userId: '00000000-0000-0000-0000-000000000001', role, mustChangePassword: false }, ...fakeReqRes,
})

describe('audit router', () => {
  let olderEventId: string
  let newerEventId: string

  beforeAll(async () => {
    const [actor] = await db
      .insert(schema.appUser)
      .values({
        email: `audit-screen-${Date.now()}@dealership.test`,
        displayName: 'Historic Disabled Actor',
        passwordHash: 'x:y',
        role: 'MANAGER',
      })
      .returning()
    const events = await db
      .insert(schema.auditEvents)
      .values([
        {
          actorUserId: actor.id,
          action: 'audit.test.older',
          entityType: 'app_user',
          entityId: actor.id,
          before: { enabled: true },
          after: { enabled: false },
          createdAt: new Date('2099-01-01T00:00:00Z'),
        },
        {
          actorUserId: actor.id,
          action: 'audit.test.newer',
          entityType: 'app_user',
          entityId: actor.id,
          before: { enabled: false },
          after: { enabled: true },
          createdAt: new Date('2099-01-02T00:00:00Z'),
        },
      ])
      .returning()
    olderEventId = events[0].id
    newerEventId = events[1].id
    await db.update(schema.appUser).set({ isActive: false }).where(eq(schema.appUser.id, actor.id))
  })

  it.each(['BDC', 'REP'] as const)('denies %s', async (role) => {
    await expect(caller(role).list({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it.each(['ADMIN', 'MANAGER'] as const)('allows %s', async (role) => {
    await expect(caller(role).list({ limit: 1 })).resolves.toEqual(expect.objectContaining({ items: expect.any(Array), hasMore: expect.any(Boolean) }))
  })

  it('returns newest first with actor identity and complete before/after state', async () => {
    const result = await caller('ADMIN').list({ limit: 100 })
    const olderIndex = result.items.findIndex((item) => item.id === olderEventId)
    const newerIndex = result.items.findIndex((item) => item.id === newerEventId)
    expect(newerIndex).toBeGreaterThanOrEqual(0)
    expect(olderIndex).toBeGreaterThan(newerIndex)
    expect(result.items[newerIndex]).toMatchObject({
      actor: { displayName: 'Historic Disabled Actor' },
      before: { enabled: false },
      after: { enabled: true },
    })
  })
})
