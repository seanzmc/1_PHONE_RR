import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate, periodKey, rankReps, type RepRankInput } from '@phoneup/core'
import { ensureEligibilitySnapshots } from './ensureEligibilitySnapshots'
import { selectActiveReps } from './activeReps'
import { publishAssignment } from '../realtime/bus'

const ADVISORY_LOCK_KEY = 42_100_1
const INBOUND_EVENTS = ['ASSIGN', 'REASSIGN_IN'] as const

export type SkipLeadInput = {
  leadId: string
  expectedRepId: string
  reasonNote: string
  idempotencyKey: string
  actorUserId: string
}

export type SkipLeadResult = {
  leadId: string
  assignedRepId: string | null
  skippedRepId: string
  queueSnapshot: RepRankInput[]
  duplicatePhone: false
  customerName: string
  assignedAt: string
  idempotent: boolean
}

function hashRepIdToSeed(repId: string): number {
  let hash = 0
  for (const character of repId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash
}

async function latestCreditedAt(tx: any, repId: string, leadPeriodKey: string): Promise<Date | null> {
  const rows = await tx
    .select({
      leadId: schema.assignmentEvents.leadId,
      creditDelta: schema.assignmentEvents.creditDelta,
      createdAt: schema.assignmentEvents.createdAt,
    })
    .from(schema.assignmentEvents)
    .innerJoin(schema.lead, eq(schema.lead.id, schema.assignmentEvents.leadId))
    .where(and(eq(schema.assignmentEvents.repId, repId), eq(schema.lead.periodKey, leadPeriodKey)))

  const byLead = new Map<string, { balance: number; latestPositive: Date | null }>()
  for (const row of rows) {
    if (!row.leadId) continue
    const value = byLead.get(row.leadId) ?? { balance: 0, latestPositive: null }
    value.balance += row.creditDelta
    if (row.creditDelta > 0 && (!value.latestPositive || row.createdAt > value.latestPositive)) {
      value.latestPositive = row.createdAt
    }
    byLead.set(row.leadId, value)
  }

  let latest: Date | null = null
  for (const value of byLead.values()) {
    if (value.balance <= 0 || !value.latestPositive) continue
    if (!latest || value.latestPositive > latest) latest = value.latestPositive
  }
  return latest
}

/**
 * Pass one assigned lead to the next available rep without undoing the skipped rep's
 * consumed cycle slot. Every click is a separate, reasoned operation; expectedRepId and
 * idempotencyKey make double-clicks and stale result cards harmless.
 */
export async function skipLead(db: DB, input: SkipLeadInput): Promise<SkipLeadResult> {
  const reasonNote = input.reasonNote.trim()
  if (!reasonNote) throw new Error('skip reason is required')

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const existing = await tx.query.assignmentEvents.findFirst({
      where: eq(schema.assignmentEvents.idempotencyKey, input.idempotencyKey),
    })
    if (existing) {
      if (existing.eventType !== 'SKIP' || existing.leadId !== input.leadId || existing.repId !== input.expectedRepId) {
        throw new Error('idempotency key is already used by another assignment operation')
      }
      const currentLead = await tx.query.lead.findFirst({ where: eq(schema.lead.id, input.leadId) })
      if (!currentLead) throw new Error(`lead ${input.leadId} not found`)
      const customer = await tx.query.customer.findFirst({ where: eq(schema.customer.id, currentLead.customerId) })
      return {
        leadId: currentLead.id,
        assignedRepId: currentLead.assignedRepId,
        skippedRepId: input.expectedRepId,
        queueSnapshot: existing.queueSnapshot as RepRankInput[],
        duplicatePhone: false as const,
        customerName: customer?.fullName ?? 'Customer',
        assignedAt: existing.createdAt.toISOString(),
        idempotent: true,
      }
    }

    const lead = await tx.query.lead.findFirst({ where: eq(schema.lead.id, input.leadId) })
    if (!lead) throw new Error(`lead ${input.leadId} not found`)
    if (lead.status !== 'ASSIGNED' || lead.assignedRepId !== input.expectedRepId) {
      throw new Error('assignment changed; refresh and try again')
    }
    const customer = await tx.query.customer.findFirst({ where: eq(schema.customer.id, lead.customerId) })
    if (!customer) throw new Error('lead customer is missing')

    const currentInbound = await tx.query.assignmentEvents.findFirst({
      where: and(
        eq(schema.assignmentEvents.leadId, lead.id),
        eq(schema.assignmentEvents.repId, input.expectedRepId),
        inArray(schema.assignmentEvents.eventType, [...INBOUND_EVENTS]),
      ),
      orderBy: [desc(schema.assignmentEvents.createdAt)],
    })
    if (!currentInbound) throw new Error('assigned lead has no current inbound ledger event')

    const now = new Date()
    const bDate = businessDate(now)
    const pKey = periodKey(bDate)
    await ensureEligibilitySnapshots(tx, bDate)

    let cycle = await tx.query.rotationCycle.findFirst({ where: isNull(schema.rotationCycle.closedAt) })
    if (!cycle) {
      const [created] = await tx.insert(schema.rotationCycle).values({}).returning()
      cycle = created
    }

    const activeReps = await selectActiveReps(tx)
    const activeRepIds = new Set(activeReps.map((rep: any) => rep.id))
    const statuses = (await tx.query.repDailyStatus.findMany({
      where: eq(schema.repDailyStatus.businessDate, bDate),
    })).filter((status: any) => activeRepIds.has(status.repId))
    const counters = await tx.query.repMonthCounters.findMany({
      where: eq(schema.repMonthCounters.periodKey, pKey),
    })
    const cycleSlots = await tx.query.rrCycleAssignments.findMany({
      where: eq(schema.rrCycleAssignments.cycleId, cycle.id),
    })
    const servedSet = new Set(cycleSlots.map((slot: any) => slot.repId))
    const counterByRep = new Map(counters.map((counter: any) => [counter.repId, counter]))
    const ranked = rankReps(statuses.map((status: any) => ({
      repId: status.repId,
      isEligible: status.status === 'ELIGIBLE',
      ineligibleReason: status.reason ?? undefined,
      servedThisCycle: servedSet.has(status.repId),
      monthlyLoad: counterByRep.get(status.repId)?.upsMtd ?? 0,
      lastAssignedAt: counterByRep.get(status.repId)?.lastAssignedAt?.toISOString() ?? null,
      rotationSeed: hashRepIdToSeed(status.repId),
    })))
    const nextRep = ranked.find(
      (rep) => rep.isEligible && !servedSet.has(rep.repId) && rep.repId !== input.expectedRepId,
    )

    await tx.insert(schema.assignmentEvents).values({
      leadId: lead.id,
      repId: input.expectedRepId,
      eventType: 'SKIP',
      cycleNo: currentInbound.cycleNo,
      creditDelta: -1,
      queueSnapshot: ranked,
      idempotencyKey: input.idempotencyKey,
    })
    const sourceUpdated = await tx
      .update(schema.repMonthCounters)
      .set({
        upsMtd: sql`greatest(${schema.repMonthCounters.upsMtd} - 1, 0)`,
        upsToday: sql`greatest(${schema.repMonthCounters.upsToday} - 1, 0)`,
        chargedSkipsMtd: sql`${schema.repMonthCounters.chargedSkipsMtd} + 1`,
        lastAssignedAt: await latestCreditedAt(tx, input.expectedRepId, lead.periodKey),
      })
      .where(and(
        eq(schema.repMonthCounters.repId, input.expectedRepId),
        eq(schema.repMonthCounters.periodKey, lead.periodKey),
      ))
      .returning({ id: schema.repMonthCounters.id })
    if (sourceUpdated.length !== 1) throw new Error('source rep counter is missing')

    let assignedRepId: string | null = null
    let status: 'ASSIGNED' | 'UNASSIGNED' = 'UNASSIGNED'
    if (nextRep) {
      assignedRepId = nextRep.repId
      status = 'ASSIGNED'
      await tx.insert(schema.assignmentEvents).values({
        leadId: lead.id,
        repId: nextRep.repId,
        eventType: 'ASSIGN',
        cycleNo: cycle.id,
        creditDelta: 1,
        queueSnapshot: ranked,
        idempotencyKey: `${input.idempotencyKey}:assign`,
      })
      await tx.insert(schema.rrCycleAssignments).values({ cycleId: cycle.id, repId: nextRep.repId })
      await tx
        .insert(schema.repMonthCounters)
        .values({ repId: nextRep.repId, periodKey: lead.periodKey, upsMtd: 1, upsToday: 1, lastAssignedAt: now })
        .onConflictDoUpdate({
          target: [schema.repMonthCounters.repId, schema.repMonthCounters.periodKey],
          set: {
            upsMtd: sql`${schema.repMonthCounters.upsMtd} + 1`,
            upsToday: sql`${schema.repMonthCounters.upsToday} + 1`,
            lastAssignedAt: now,
          },
        })

      const nowServed = new Set([...servedSet, nextRep.repId])
      const eligible = ranked.filter((rep) => rep.isEligible)
      if (eligible.length > 0 && eligible.every((rep) => nowServed.has(rep.repId))) {
        await tx.update(schema.rotationCycle).set({ closedAt: now }).where(eq(schema.rotationCycle.id, cycle.id))
        await tx.insert(schema.rotationCycle).values({})
      }
    } else {
      await tx.insert(schema.unassignedQueue).values({
        leadId: lead.id,
        reason: 'REP_SKIPPED_NO_ELIGIBLE_REP',
      })
    }

    await tx
      .update(schema.lead)
      .set({ assignedRepId, status })
      .where(eq(schema.lead.id, lead.id))
    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'lead.skip',
      entityType: 'lead',
      entityId: lead.id,
      before: { status: lead.status, assignedRepId: input.expectedRepId },
      after: {
        status,
        assignedRepId,
        skippedRepId: input.expectedRepId,
        servedThisCycle: true,
        reasonNote,
      },
    })

    return {
      leadId: lead.id,
      assignedRepId,
      skippedRepId: input.expectedRepId,
      queueSnapshot: ranked,
      duplicatePhone: false as const,
      customerName: customer.fullName,
      assignedAt: now.toISOString(),
      idempotent: false,
    }
  })

  if (!result.idempotent) publishAssignment({ type: 'SKIP', ...result })
  return result
}
