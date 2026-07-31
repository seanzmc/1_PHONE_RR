import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import { publishAssignment } from '../realtime/bus'
import { isActiveRep } from './activeReps'

const ADVISORY_LOCK_KEY = 42_100_1
const INBOUND_EVENTS = ['ASSIGN', 'REASSIGN_IN'] as const

export type ReassignLeadInput = {
  leadId: string
  targetRepId: string
  reasonNote: string
  idempotencyKey: string
  actorUserId: string
}

export type ReassignLeadResult = {
  leadId: string
  assignedRepId: string
  previousRepId: string
  idempotent: boolean
}

async function latestCreditedAt(
  tx: any,
  repId: string,
  periodKey: string,
): Promise<Date | null> {
  const rows = await tx
    .select({
      leadId: schema.assignmentEvents.leadId,
      creditDelta: schema.assignmentEvents.creditDelta,
      createdAt: schema.assignmentEvents.createdAt,
    })
    .from(schema.assignmentEvents)
    .innerJoin(schema.lead, eq(schema.lead.id, schema.assignmentEvents.leadId))
    .where(and(eq(schema.assignmentEvents.repId, repId), eq(schema.lead.periodKey, periodKey)))

  const byLead = new Map<string, { balance: number; latestPositive: Date | null }>()
  for (const row of rows) {
    if (!row.leadId) continue
    const current = byLead.get(row.leadId) ?? { balance: 0, latestPositive: null }
    current.balance += row.creditDelta
    if (row.creditDelta > 0 && (!current.latestPositive || row.createdAt > current.latestPositive)) {
      current.latestPositive = row.createdAt
    }
    byLead.set(row.leadId, current)
  }

  let latest: Date | null = null
  for (const value of byLead.values()) {
    if (value.balance <= 0 || !value.latestPositive) continue
    if (!latest || value.latestPositive > latest) latest = value.latestPositive
  }
  return latest
}

export async function reassignLead(db: DB, input: ReassignLeadInput): Promise<ReassignLeadResult> {
  if (!input.reasonNote.trim()) throw new Error('reassignment reason is required')

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const existing = await tx.query.assignmentEvents.findFirst({
      where: eq(schema.assignmentEvents.idempotencyKey, input.idempotencyKey),
    })
    if (existing) {
      if (existing.eventType !== 'REASSIGN_IN' || existing.leadId !== input.leadId || !existing.repId) {
        throw new Error('idempotency key is already used by another assignment operation')
      }
      const pairedOut = await tx.query.assignmentEvents.findFirst({
        where: eq(schema.assignmentEvents.idempotencyKey, `${input.idempotencyKey}:out`),
      })
      if (!pairedOut?.repId) throw new Error('reassignment ledger pair is incomplete')
      return {
        leadId: input.leadId,
        assignedRepId: existing.repId,
        previousRepId: pairedOut.repId,
        idempotent: true,
      }
    }

    const lead = await tx.query.lead.findFirst({ where: eq(schema.lead.id, input.leadId) })
    if (!lead) throw new Error(`lead ${input.leadId} not found`)
    if (lead.status !== 'ASSIGNED' || !lead.assignedRepId) {
      throw new Error('only assigned leads can be reassigned')
    }
    if (lead.assignedRepId === input.targetRepId) throw new Error('target rep is already assigned')
    if (!(await isActiveRep(tx, input.targetRepId))) {
      throw new Error('target rep account is disabled or missing')
    }

    const sourceRepId = lead.assignedRepId
    const currentInbound = await tx.query.assignmentEvents.findFirst({
      where: and(
        eq(schema.assignmentEvents.leadId, lead.id),
        eq(schema.assignmentEvents.repId, sourceRepId),
        inArray(schema.assignmentEvents.eventType, [...INBOUND_EVENTS]),
      ),
      orderBy: [desc(schema.assignmentEvents.createdAt)],
    })
    if (!currentInbound) throw new Error('assigned lead has no current inbound ledger event')

    const now = new Date()
    const cycle = await tx.query.rotationCycle.findFirst({
      where: eq(schema.rotationCycle.id, currentInbound.cycleNo),
    })
    // An old reassignment transfers credit but must not reopen or rewrite a completed cycle.
    // For the currently-open cycle, transfer the consumed slot with the lead.
    if (cycle && !cycle.closedAt) {
      await tx
        .delete(schema.rrCycleAssignments)
        .where(
          and(
            eq(schema.rrCycleAssignments.cycleId, cycle.id),
            eq(schema.rrCycleAssignments.repId, sourceRepId),
          ),
        )
      const targetSlot = await tx.query.rrCycleAssignments.findFirst({
        where: and(
          eq(schema.rrCycleAssignments.cycleId, cycle.id),
          eq(schema.rrCycleAssignments.repId, input.targetRepId),
        ),
      })
      if (!targetSlot) {
        await tx.insert(schema.rrCycleAssignments).values({
          cycleId: cycle.id,
          repId: input.targetRepId,
        })
      }
    }

    await tx.insert(schema.assignmentEvents).values({
      leadId: lead.id,
      repId: sourceRepId,
      eventType: 'REASSIGN_OUT',
      cycleNo: currentInbound.cycleNo,
      creditDelta: -1,
      queueSnapshot: currentInbound.queueSnapshot,
      idempotencyKey: `${input.idempotencyKey}:out`,
    })
    await tx.insert(schema.assignmentEvents).values({
      leadId: lead.id,
      repId: input.targetRepId,
      eventType: 'REASSIGN_IN',
      cycleNo: currentInbound.cycleNo,
      creditDelta: 1,
      queueSnapshot: currentInbound.queueSnapshot,
      idempotencyKey: input.idempotencyKey,
    })

    const countsToday = lead.businessDate === businessDate(now)
    const sourceUpdated = await tx
      .update(schema.repMonthCounters)
      .set({
        upsMtd: sql`greatest(${schema.repMonthCounters.upsMtd} - 1, 0)`,
        ...(countsToday
          ? { upsToday: sql`greatest(${schema.repMonthCounters.upsToday} - 1, 0)` }
          : {}),
        lastAssignedAt: await latestCreditedAt(tx, sourceRepId, lead.periodKey),
      })
      .where(
        and(
          eq(schema.repMonthCounters.repId, sourceRepId),
          eq(schema.repMonthCounters.periodKey, lead.periodKey),
        ),
      )
      .returning({ id: schema.repMonthCounters.id })
    if (sourceUpdated.length !== 1) throw new Error('source rep counter is missing')

    await tx
      .insert(schema.repMonthCounters)
      .values({
        repId: input.targetRepId,
        periodKey: lead.periodKey,
        upsMtd: 1,
        upsToday: countsToday ? 1 : 0,
        lastAssignedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.repMonthCounters.repId, schema.repMonthCounters.periodKey],
        set: {
          upsMtd: sql`${schema.repMonthCounters.upsMtd} + 1`,
          ...(countsToday ? { upsToday: sql`${schema.repMonthCounters.upsToday} + 1` } : {}),
          lastAssignedAt: now,
        },
      })

    await tx
      .update(schema.lead)
      .set({ assignedRepId: input.targetRepId })
      .where(eq(schema.lead.id, lead.id))
    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'lead.reassign',
      entityType: 'lead',
      entityId: lead.id,
      before: { assignedRepId: sourceRepId },
      after: { assignedRepId: input.targetRepId, reasonNote: input.reasonNote.trim() },
    })

    return {
      leadId: lead.id,
      assignedRepId: input.targetRepId,
      previousRepId: sourceRepId,
      idempotent: false,
    }
  })

  if (!result.idempotent) publishAssignment({ type: 'REASSIGN', ...result })
  return result
}
