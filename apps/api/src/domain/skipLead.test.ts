import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import { assignLead } from './assignLead'
import { skipLead } from './skipLead'
import { reconcile } from '../jobs/reconciliation'
import { t } from '../trpc/router'
import { assignmentRouter } from '../routers/assignment'

let bdcUserId: string
let eligibleRepIds: string[] = []

beforeAll(async () => {
  const bdc = await db.query.appUser.findFirst({ where: eq(schema.appUser.role, 'BDC') })
  bdcUserId = bdc!.id
  const statuses = await db.query.repDailyStatus.findMany({
    where: and(
      eq(schema.repDailyStatus.businessDate, businessDate(new Date())),
      eq(schema.repDailyStatus.status, 'ELIGIBLE'),
    ),
  })
  eligibleRepIds = statuses.map((status) => status.repId)
  expect(eligibleRepIds.length).toBeGreaterThanOrEqual(3)
})

beforeEach(async () => {
  await db.delete(schema.auditEvents).where(eq(schema.auditEvents.action, 'lead.skip'))
  await db.delete(schema.assignmentEvents)
  await db.delete(schema.rrCycleAssignments)
  await db.delete(schema.unassignedQueue)
  await db.delete(schema.lead)
  await db.delete(schema.customer)
  await db.delete(schema.repMonthCounters)
})

async function assignTo(repId: string) {
  return assignLead(db, {
    idempotencyKey: randomUUID(),
    customerName: 'Skip Customer',
    customerPhoneE164: `+1${randomUUID().replace(/\D/g, '').padEnd(10, '7').slice(0, 10)}`,
    forcedRepId: repId,
    actorUserId: bdcUserId,
  })
}

describe('skipLead', () => {
  it('preserves the lead, leaves the unavailable rep served, passes the up and audits the transition', async () => {
    const assigned = await assignTo(eligibleRepIds[0])
    const reasonNote = 'Rep stepped away from the floor'

    const result = await skipLead(db, {
      leadId: assigned.leadId,
      expectedRepId: assigned.assignedRepId!,
      reasonNote,
      idempotencyKey: randomUUID(),
      actorUserId: bdcUserId,
    })

    expect(result).toMatchObject({
      leadId: assigned.leadId,
      skippedRepId: assigned.assignedRepId,
      customerName: 'Skip Customer',
      idempotent: false,
    })
    expect(result.assignedRepId).toBeTruthy()
    expect(result.assignedRepId).not.toBe(assigned.assignedRepId)

    const lead = await db.query.lead.findFirst({ where: eq(schema.lead.id, assigned.leadId) })
    expect(lead).toMatchObject({ status: 'ASSIGNED', assignedRepId: result.assignedRepId })

    const events = await db.query.assignmentEvents.findMany({
      where: eq(schema.assignmentEvents.leadId, assigned.leadId),
    })
    expect(events.find((event) => event.eventType === 'SKIP')).toMatchObject({
      repId: assigned.assignedRepId,
      creditDelta: -1,
    })
    expect(events.filter((event) => event.eventType === 'ASSIGN')).toHaveLength(2)

    const sourceCounter = await db.query.repMonthCounters.findFirst({
      where: eq(schema.repMonthCounters.repId, assigned.assignedRepId!),
    })
    expect(sourceCounter).toMatchObject({ upsMtd: 0, upsToday: 0, chargedSkipsMtd: 1 })

    const sourceSlot = await db.query.rrCycleAssignments.findFirst({
      where: eq(schema.rrCycleAssignments.repId, assigned.assignedRepId!),
    })
    expect(sourceSlot).toBeTruthy()

    const audit = await db.query.auditEvents.findFirst({
      where: and(
        eq(schema.auditEvents.action, 'lead.skip'),
        eq(schema.auditEvents.entityId, assigned.leadId),
      ),
    })
    expect(audit?.actorUserId).toBe(bdcUserId)
    expect(audit?.before).toMatchObject({
      status: 'ASSIGNED',
      assignedRepId: assigned.assignedRepId,
    })
    expect(audit?.after).toMatchObject({
      status: 'ASSIGNED',
      assignedRepId: result.assignedRepId,
      skippedRepId: assigned.assignedRepId,
      reasonNote,
    })
    expect((await reconcile(db)).mismatches).toEqual([])
  })

  it('allows another deliberate skip but makes retries and stale clicks harmless', async () => {
    const assigned = await assignTo(eligibleRepIds[0])
    const firstKey = randomUUID()
    const first = await skipLead(db, {
      leadId: assigned.leadId,
      expectedRepId: assigned.assignedRepId!,
      reasonNote: 'First rep unavailable',
      idempotencyKey: firstKey,
      actorUserId: bdcUserId,
    })
    const retry = await skipLead(db, {
      leadId: assigned.leadId,
      expectedRepId: assigned.assignedRepId!,
      reasonNote: 'First rep unavailable',
      idempotencyKey: firstKey,
      actorUserId: bdcUserId,
    })
    expect(retry.idempotent).toBe(true)

    await expect(skipLead(db, {
      leadId: assigned.leadId,
      expectedRepId: assigned.assignedRepId!,
      reasonNote: 'Stale tab',
      idempotencyKey: randomUUID(),
      actorUserId: bdcUserId,
    })).rejects.toThrow(/assignment changed/i)

    const second = await skipLead(db, {
      leadId: assigned.leadId,
      expectedRepId: first.assignedRepId!,
      reasonNote: 'Second rep also unavailable',
      idempotencyKey: randomUUID(),
      actorUserId: bdcUserId,
    })
    expect(second.skippedRepId).toBe(first.assignedRepId)
    expect(second.idempotent).toBe(false)

    const skips = await db.query.assignmentEvents.findMany({
      where: and(
        eq(schema.assignmentEvents.leadId, assigned.leadId),
        eq(schema.assignmentEvents.eventType, 'SKIP'),
      ),
    })
    expect(skips).toHaveLength(2)
  })
})

describe('assignment.skip permission', () => {
  it('rejects REP before touching assignment state', async () => {
    const caller = t.createCallerFactory(assignmentRouter)({
      session: {
        userId: randomUUID(),
        role: 'REP',
        mustChangePassword: false,
        sessionId: randomUUID(),
      },
      req: {},
      res: {},
    } as any)

    await expect(caller.skip({
      leadId: randomUUID(),
      expectedRepId: randomUUID(),
      reasonNote: 'Not available',
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('prevents BDC users from skipping another BDC user\'s lead', async () => {
    const assigned = await assignTo(eligibleRepIds[0])
    const caller = t.createCallerFactory(assignmentRouter)({
      session: {
        userId: randomUUID(),
        role: 'BDC',
        mustChangePassword: false,
        sessionId: randomUUID(),
      },
      req: {},
      res: {},
    } as any)

    await expect(caller.skip({
      leadId: assigned.leadId,
      expectedRepId: assigned.assignedRepId!,
      reasonNote: 'Not available',
      idempotencyKey: randomUUID(),
    })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
