import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
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
  let actorId: string
  let otherActorId: string
  let targetUserId: string
  let duplicateUserId: string
  let targetRepId: string
  let duplicateRepId: string
  let targetLeadId: string
  let unresolvedActorId: string
  let excludedImportEventId: string
  let combinedEventId: string
  let otherActorEventId: string
  let filterAction: string
  let paginationAction: string
  let standardDateAction: string
  let daylightDateAction: string
  let standardIncludedIds: string[]
  let daylightIncludedIds: string[]

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
    actorId = actor.id
    const stamp = Date.now()
    filterAction = `audit.filter.${stamp}`
    paginationAction = `audit.pagination.${stamp}`
    standardDateAction = `audit.standardDate.${stamp}`
    daylightDateAction = `audit.daylightDate.${stamp}`
    targetLeadId = randomUUID()
    unresolvedActorId = randomUUID()

    const [otherActor, targetUser, duplicateUser, repUser, duplicateRepUser] = await db
      .insert(schema.appUser)
      .values([
        { email: `audit-actor-${stamp}@dealership.test`, passwordHash: 'x:y', role: 'MANAGER' },
        { email: `audit-target-${stamp}@dealership.test`, displayName: 'Duplicate Audit Person', passwordHash: 'x:y', role: 'BDC' },
        { email: `audit-target-duplicate-${stamp}@dealership.test`, displayName: 'Duplicate Audit Person', passwordHash: 'x:y', role: 'BDC' },
        { email: `audit-rep-${stamp}@dealership.test`, displayName: 'Audit Rep User', passwordHash: 'x:y', role: 'REP' },
        { email: `audit-rep-duplicate-${stamp}@dealership.test`, displayName: 'Audit Rep User Two', passwordHash: 'x:y', role: 'REP' },
      ])
      .returning()
    otherActorId = otherActor.id
    targetUserId = targetUser.id
    duplicateUserId = duplicateUser.id

    const [targetRep, duplicateRep] = await db.insert(schema.salesRep).values([
      { userId: repUser.id, displayName: 'Duplicate Audit Rep', hireDate: '2099-01-01' },
      { userId: duplicateRepUser.id, displayName: 'Duplicate Audit Rep', hireDate: '2099-01-01' },
    ]).returning()
    targetRepId = targetRep.id
    duplicateRepId = duplicateRep.id

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

    const filterEvents = await db.insert(schema.auditEvents).values([
      {
        actorUserId: actor.id,
        action: filterAction,
        entityType: 'app_user',
        entityId: targetUserId,
        createdAt: new Date('2099-07-15T12:00:00Z'),
      },
      {
        actorUserId: otherActor.id,
        action: filterAction,
        entityType: 'app_user',
        entityId: targetUserId,
        createdAt: new Date('2099-07-15T12:01:00Z'),
      },
      {
        actorUserId: actor.id,
        action: `${filterAction}.other`,
        entityType: 'app_user',
        entityId: targetUserId,
        createdAt: new Date('2099-07-15T12:02:00Z'),
      },
      {
        actorUserId: actor.id,
        action: filterAction,
        entityType: 'lead',
        entityId: targetLeadId,
        createdAt: new Date('2099-07-15T12:03:00Z'),
      },
      { actorUserId: actor.id, action: 'rep.test.sales', entityType: 'sales_rep', entityId: targetRepId },
      { actorUserId: actor.id, action: 'rep.test.status', entityType: 'rep_daily_status', entityId: targetRepId },
      { actorUserId: actor.id, action: 'activity.metric.edit', entityType: 'rep_daily_activity', entityId: targetRepId },
      { actorUserId: actor.id, action: 'activity.import', entityType: 'rep_daily_activity', entityId: targetRepId },
      { actorUserId: unresolvedActorId, action: `${filterAction}.unresolved`, entityType: 'lead', entityId: targetLeadId },
    ]).returning()
    combinedEventId = filterEvents[0].id
    otherActorEventId = filterEvents[1].id
    excludedImportEventId = filterEvents[7].id

    await db.insert(schema.auditEvents).values([0, 1, 2].map(() => ({
      actorUserId: actor.id,
      action: paginationAction,
      entityType: 'lead',
      entityId: randomUUID(),
      createdAt: new Date('2099-08-01T12:00:00Z'),
    })))

    const standardDateEvents = await db.insert(schema.auditEvents).values([
      { actorUserId: actor.id, action: standardDateAction, entityType: 'lead', entityId: randomUUID(), createdAt: new Date('2099-01-15T04:59:59Z') },
      { actorUserId: actor.id, action: standardDateAction, entityType: 'lead', entityId: randomUUID(), createdAt: new Date('2099-01-15T05:00:00Z') },
      { actorUserId: actor.id, action: standardDateAction, entityType: 'lead', entityId: randomUUID(), createdAt: new Date('2099-01-16T04:59:59Z') },
      { actorUserId: actor.id, action: standardDateAction, entityType: 'lead', entityId: randomUUID(), createdAt: new Date('2099-01-16T05:00:00Z') },
    ]).returning()
    standardIncludedIds = [standardDateEvents[1].id, standardDateEvents[2].id]

    const daylightDateEvents = await db.insert(schema.auditEvents).values([
      { actorUserId: actor.id, action: daylightDateAction, entityType: 'lead', entityId: randomUUID(), createdAt: new Date('2099-07-15T03:59:59Z') },
      { actorUserId: actor.id, action: daylightDateAction, entityType: 'lead', entityId: randomUUID(), createdAt: new Date('2099-07-15T04:00:00Z') },
      { actorUserId: actor.id, action: daylightDateAction, entityType: 'lead', entityId: randomUUID(), createdAt: new Date('2099-07-16T03:59:59Z') },
      { actorUserId: actor.id, action: daylightDateAction, entityType: 'lead', entityId: randomUUID(), createdAt: new Date('2099-07-16T04:00:00Z') },
    ]).returning()
    daylightIncludedIds = [daylightDateEvents[1].id, daylightDateEvents[2].id]
  })

  it.each(['BDC', 'REP'] as const)('denies %s', async (role) => {
    await expect(caller(role).list({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(caller(role).filterOptions()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it.each(['ADMIN', 'MANAGER'] as const)('allows %s', async (role) => {
    await expect(caller(role).list({ limit: 1 })).resolves.toEqual(expect.objectContaining({ items: expect.any(Array), hasMore: expect.any(Boolean) }))
    await expect(caller(role).filterOptions()).resolves.toEqual(expect.objectContaining({
      actions: expect.any(Array),
      actors: expect.any(Array),
      users: expect.any(Array),
      reps: expect.any(Array),
    }))
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

  it('combines exact action, actor, affected user, and date predicates with AND', async () => {
    const actionOnly = await caller('ADMIN').list({ action: filterAction, limit: 100 })
    expect(actionOnly.items.map((item) => item.id)).toEqual(expect.arrayContaining([combinedEventId, otherActorEventId]))

    const actorOnly = await caller('ADMIN').list({ actorUserId: actorId, limit: 100 })
    expect(actorOnly.items.map((item) => item.id)).toContain(combinedEventId)
    expect(actorOnly.items.map((item) => item.id)).not.toContain(otherActorEventId)

    const combined = await caller('ADMIN').list({
      action: filterAction,
      actorUserId: actorId,
      affected: { kind: 'USER', id: targetUserId },
      fromDate: '2099-07-15',
      toDate: '2099-07-15',
      limit: 100,
    })
    expect(combined.items.map((item) => item.id)).toEqual([combinedEventId])
  })

  it('matches only primary affected user, lead, and truthful rep entity types', async () => {
    const users = await caller('MANAGER').list({ affected: { kind: 'USER', id: targetUserId }, limit: 100 })
    expect(users.items.length).toBeGreaterThanOrEqual(3)
    expect(users.items.every((item) => item.entityType === 'app_user' && item.entityId === targetUserId)).toBe(true)

    const leads = await caller('MANAGER').list({ affected: { kind: 'LEAD', id: targetLeadId }, limit: 100 })
    expect(leads.items.length).toBeGreaterThanOrEqual(2)
    expect(leads.items.every((item) => item.entityType === 'lead' && item.entityId === targetLeadId)).toBe(true)

    const reps = await caller('MANAGER').list({ affected: { kind: 'REP', id: targetRepId }, limit: 100 })
    expect(reps.items.map((item) => item.entityType)).toEqual(expect.arrayContaining([
      'sales_rep',
      'rep_daily_status',
      'rep_daily_activity',
    ]))
    expect(reps.items.map((item) => item.id)).not.toContain(excludedImportEventId)
    expect(reps.items.find((item) => item.entityType === 'rep_daily_activity')?.action).toBe('activity.metric.edit')
  })

  it('uses inclusive New York dates across standard and daylight-saving time', async () => {
    const standard = await caller('ADMIN').list({
      action: standardDateAction,
      fromDate: '2099-01-15',
      toDate: '2099-01-15',
    })
    expect(standard.items.map((item) => item.id).sort()).toEqual([...standardIncludedIds].sort())

    const fromOnly = await caller('ADMIN').list({ action: standardDateAction, fromDate: '2099-01-15' })
    const toOnly = await caller('ADMIN').list({ action: standardDateAction, toDate: '2099-01-15' })
    expect(fromOnly.items).toHaveLength(3)
    expect(toOnly.items).toHaveLength(3)

    const daylight = await caller('ADMIN').list({
      action: daylightDateAction,
      fromDate: '2099-07-15',
      toDate: '2099-07-15',
    })
    expect(daylight.items.map((item) => item.id).sort()).toEqual([...daylightIncludedIds].sort())
  })

  it('applies offset and hasMore to the filtered, deterministically ordered result set', async () => {
    const all = await caller('ADMIN').list({ action: paginationAction, limit: 100 })
    const first = await caller('ADMIN').list({ action: paginationAction, limit: 2, offset: 0 })
    const second = await caller('ADMIN').list({ action: paginationAction, limit: 2, offset: 2 })

    expect(all.items).toHaveLength(3)
    expect(first.hasMore).toBe(true)
    expect(second.hasMore).toBe(false)
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(all.items.map((item) => item.id))
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3)
  })

  it.each([
    { actorUserId: 'not-a-uuid' },
    { affected: { kind: 'LEAD', id: 'not-a-uuid' } },
    { affected: { kind: 'REP' } },
    { fromDate: '2099-02-29' },
    { fromDate: '2099-07-16', toDate: '2099-07-15' },
  ])('rejects invalid filter input %#', async (input) => {
    await expect(caller('ADMIN').list(input as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('returns sorted, labelled filter choices with inactive and unresolved actors', async () => {
    const options = await caller('ADMIN').filterOptions()
    const action = options.actions.find((option) => option.value === filterAction)
    const actor = options.actors.find((option) => option.id === actorId)
    const fallbackActor = options.actors.find((option) => option.id === otherActorId)
    const unresolvedActor = options.actors.find((option) => option.id === unresolvedActorId)
    const duplicateUsers = options.users.filter((option) => [targetUserId, duplicateUserId].includes(option.id))
    const duplicateReps = options.reps.filter((option) => [targetRepId, duplicateRepId].includes(option.id))

    expect(action).toMatchObject({ value: filterAction, label: expect.stringContaining('Audit filter') })
    expect(actor?.label).toMatch(/^Historic Disabled Actor(?: \([0-9a-f]{8}\))?$/)
    expect(fallbackActor?.label).toContain('audit-actor-')
    expect(unresolvedActor?.label).toBe(unresolvedActorId)
    expect(duplicateUsers).toHaveLength(2)
    expect(duplicateUsers.every((option) => /\([0-9a-f]{8}\)$/.test(option.label))).toBe(true)
    expect(duplicateReps).toHaveLength(2)
    expect(duplicateReps.every((option) => /\([0-9a-f]{8}\)$/.test(option.label))).toBe(true)
    expect(options.actions.map((option) => option.label)).toEqual(
      [...options.actions.map((option) => option.label)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    )
  })
})
