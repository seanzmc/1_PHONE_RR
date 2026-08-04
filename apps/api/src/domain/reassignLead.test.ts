import { beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { businessDate, periodKey } from '@phoneup/core'
import { assignLead } from './assignLead'
import { reassignLead } from './reassignLead'
import { reconcile } from '../jobs/reconciliation'
import { t } from '../trpc/router'
import { assignmentRouter } from '../routers/assignment'

function phone(): string {
  return `+1${randomUUID().replace(/\D/g, '').padEnd(10, '7').slice(0, 10)}`
}

/** Own account + rep row + today's status, so a test never has to borrow a shared rep. */
async function makeRep(label: string, isActive = true): Promise<string> {
  const stamp = `${Date.now()}-${randomUUID()}`
  const [user] = await db
    .insert(schema.appUser)
    .values({
      email: `reassign-${label}-${stamp}@dealership.test`,
      displayName: `Reassign ${label}`,
      passwordHash: 'x:y',
      role: 'REP',
      isActive,
    })
    .returning()
  const [rep] = await db
    .insert(schema.salesRep)
    .values({ userId: user.id, displayName: `Reassign ${label}`, hireDate: '2020-01-01' })
    .returning()
  await db.insert(schema.repDailyStatus).values({
    repId: rep.id,
    businessDate: businessDate(new Date()),
    status: 'ELIGIBLE',
    decidedBy: 'SYSTEM',
  })
  return rep.id
}

describe('reassignLead', () => {
  let actorUserId: string
  let sourceRepId: string
  let targetRepId: string
  let disabledRepId: string
  let leadId: string

  beforeAll(async () => {
    const stamp = `${Date.now()}-${randomUUID()}`
    const [actor] = await db
      .insert(schema.appUser)
      .values({
        email: `reassign-manager-${stamp}@dealership.test`,
        displayName: 'Reassign Manager',
        passwordHash: 'x:y',
        role: 'MANAGER',
      })
      .returning()
    actorUserId = actor.id

    sourceRepId = await makeRep('Source')
    targetRepId = await makeRep('Target')
    disabledRepId = await makeRep('Disabled', false)

    const assigned = await assignLead(db, {
      idempotencyKey: randomUUID(),
      customerName: 'Reassign Customer',
      customerPhoneE164: phone(),
      actorUserId,
      forcedRepId: sourceRepId,
    })
    leadId = assigned.leadId
  })

  it('moves one existing lead with a balanced ledger pair, projections and audit event', async () => {
    const key = randomUUID()
    const result = await reassignLead(db, {
      leadId,
      targetRepId,
      reasonNote: 'Manager coverage change',
      idempotencyKey: key,
      actorUserId,
    })

    expect(result).toMatchObject({
      leadId,
      assignedRepId: targetRepId,
      previousRepId: sourceRepId,
      idempotent: false,
    })
    expect((await db.query.lead.findFirst({ where: eq(schema.lead.id, leadId) }))?.assignedRepId).toBe(targetRepId)

    const events = await db.query.assignmentEvents.findMany({
      where: eq(schema.assignmentEvents.leadId, leadId),
    })
    expect(events.filter((event) => event.eventType === 'REASSIGN_OUT')).toHaveLength(1)
    expect(events.filter((event) => event.eventType === 'REASSIGN_IN')).toHaveLength(1)
    expect(events.find((event) => event.eventType === 'REASSIGN_OUT')?.creditDelta).toBe(-1)
    expect(events.find((event) => event.eventType === 'REASSIGN_IN')?.creditDelta).toBe(1)

    const pKey = periodKey(businessDate(new Date()))
    const sourceCounter = await db.query.repMonthCounters.findFirst({
      where: and(eq(schema.repMonthCounters.repId, sourceRepId), eq(schema.repMonthCounters.periodKey, pKey)),
    })
    const targetCounter = await db.query.repMonthCounters.findFirst({
      where: and(eq(schema.repMonthCounters.repId, targetRepId), eq(schema.repMonthCounters.periodKey, pKey)),
    })
    expect(sourceCounter?.upsMtd).toBe(0)
    expect(targetCounter?.upsMtd).toBe(1)

    const audit = await db.query.auditEvents.findFirst({
      where: and(eq(schema.auditEvents.action, 'lead.reassign'), eq(schema.auditEvents.entityId, leadId)),
    })
    expect(audit?.before).toMatchObject({ assignedRepId: sourceRepId })
    expect(audit?.after).toMatchObject({ assignedRepId: targetRepId, reasonNote: 'Manager coverage change' })

    const recon = await reconcile(db)
    expect(recon.mismatches.find((row) => row.repId === sourceRepId || row.repId === targetRepId)).toBeUndefined()

    const retry = await reassignLead(db, {
      leadId,
      targetRepId,
      reasonNote: 'Manager coverage change',
      idempotencyKey: key,
      actorUserId,
    })
    expect(retry).toMatchObject({
      assignedRepId: targetRepId,
      previousRepId: sourceRepId,
      idempotent: true,
    })
    const afterRetry = await db.query.assignmentEvents.findMany({
      where: eq(schema.assignmentEvents.leadId, leadId),
    })
    expect(afterRetry.filter((event) => event.eventType === 'REASSIGN_OUT')).toHaveLength(1)
    expect(afterRetry.filter((event) => event.eventType === 'REASSIGN_IN')).toHaveLength(1)
  })

  it('rejects a disabled target account without changing the current assignment', async () => {
    await expect(
      reassignLead(db, {
        leadId,
        targetRepId: disabledRepId,
        reasonNote: 'should fail',
        idempotencyKey: randomUUID(),
        actorUserId,
      }),
    ).rejects.toThrow(/disabled or missing/)
    expect((await db.query.lead.findFirst({ where: eq(schema.lead.id, leadId) }))?.assignedRepId).toBe(targetRepId)
  })
  // assigned_at is the cycle's running order and the next cycle restarts from it, so a
  // reassign has to hand the slot over in place. Delete-and-append re-stamps it with the
  // reassign time, which drops the target to the back of the next rotation for taking
  // over someone else's lead — and drops the source, who no longer holds a slot at all.
  it('hands the cycle slot to the target in place, keeping its position in the order', async () => {
    const handoverSource = await makeRep('SlotSource')
    const handoverTarget = await makeRep('SlotTarget')

    const assigned = await assignLead(db, {
      idempotencyKey: randomUUID(),
      customerName: 'Slot Handover',
      customerPhoneE164: phone(),
      actorUserId,
      forcedRepId: handoverSource,
    })

    const slotBefore = await db.query.rrCycleAssignments.findFirst({
      where: eq(schema.rrCycleAssignments.repId, handoverSource),
    })
    expect(slotBefore).toBeTruthy()

    await reassignLead(db, {
      leadId: assigned.leadId,
      targetRepId: handoverTarget,
      reasonNote: 'covering the floor',
      idempotencyKey: randomUUID(),
      actorUserId,
    })

    const slotAfter = await db.query.rrCycleAssignments.findFirst({
      where: eq(schema.rrCycleAssignments.id, slotBefore!.id),
    })
    expect(slotAfter?.repId).toBe(handoverTarget)
    expect(slotAfter?.assignedAt.toISOString()).toBe(slotBefore!.assignedAt.toISOString())

    const sourceSlots = await db.query.rrCycleAssignments.findMany({
      where: eq(schema.rrCycleAssignments.repId, handoverSource),
    })
    expect(sourceSlots).toHaveLength(0)
  })
})

describe('assignment.reassign permission', () => {
  const fakeReqRes = { req: {}, res: {} } as any

  it.each(['BDC', 'REP'] as const)('denies %s before touching the database', async (role) => {
    const caller = t.createCallerFactory(assignmentRouter)({
      session: {
        userId: randomUUID(),
        role,
        mustChangePassword: false,
        sessionId: randomUUID(),
      },
      ...fakeReqRes,
    })
    await expect(
      caller.reassign({
        leadId: randomUUID(),
        targetRepId: randomUUID(),
        reasonNote: 'not allowed',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
