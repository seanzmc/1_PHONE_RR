import { sql, eq, and, isNull } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { rankReps, businessDate, periodKey, type RepRankInput } from '@phoneup/core'
import { ensureEligibilitySnapshots } from './ensureEligibilitySnapshots'
import { publishAssignment } from '../realtime/bus'

const ADVISORY_LOCK_KEY = 42_100_1 // single store => single fixed key

export type AssignLeadInput = {
  idempotencyKey: string
  customerName: string
  customerPhoneE164: string
  notes?: string
  forcedRepId?: string
  actorUserId: string
}

export type AssignLeadResult = {
  leadId: string
  assignedRepId: string | null
  queueSnapshot: RepRankInput[]
  duplicatePhone: boolean
}

function hashRepIdToSeed(repId: string): number {
  let h = 0
  for (const c of repId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}

export async function assignLead(db: DB, input: AssignLeadInput): Promise<AssignLeadResult> {
  const result = await db.transaction(async (tx) => {
    // 1. advisory lock for the whole ordering-changing transaction
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    // 2. idempotency short-circuit
    const existing = await tx.query.assignmentEvents.findFirst({
      where: eq(schema.assignmentEvents.idempotencyKey, input.idempotencyKey),
    })
    if (existing) {
      const existingLead = await tx.query.lead.findFirst({ where: eq(schema.lead.id, existing.leadId!) })
      return {
        leadId: existing.leadId!,
        assignedRepId: existingLead?.assignedRepId ?? null,
        queueSnapshot: existing.queueSnapshot as RepRankInput[],
        duplicatePhone: false,
      }
    }

    // 3. business date / period key inside the lock
    const now = new Date()
    const bDate = businessDate(now)
    const pKey = periodKey(bDate)

    // 4. lazy ensure eligibility snapshots (fail-open if nightly job died)
    await ensureEligibilitySnapshots(tx, bDate)

    // 5. get-or-open current cycle
    let cycle = await tx.query.rotationCycle.findFirst({ where: isNull(schema.rotationCycle.closedAt) })
    if (!cycle) {
      const [created] = await tx.insert(schema.rotationCycle).values({}).returning()
      cycle = created
    }

    // 6. rank all members (eligible + ineligible, for full board display)
    const statuses = await tx.query.repDailyStatus.findMany({
      where: eq(schema.repDailyStatus.businessDate, bDate),
    })
    const counters = await tx.query.repMonthCounters.findMany({
      where: eq(schema.repMonthCounters.periodKey, pKey),
    })
    const servedThisCycle = await tx.query.rrCycleAssignments.findMany({
      where: eq(schema.rrCycleAssignments.cycleId, cycle.id),
    })
    const servedSet = new Set(servedThisCycle.map((s: any) => s.repId))
    const counterByRep = new Map(counters.map((c: any) => [c.repId, c]))

    const rankInputs: RepRankInput[] = statuses.map((s: any) => ({
      repId: s.repId,
      isEligible: s.status === 'ELIGIBLE',
      ineligibleReason: s.reason ?? undefined,
      servedThisCycle: servedSet.has(s.repId),
      monthlyLoad: counterByRep.get(s.repId)?.upsMtd ?? 0,
      lastAssignedAt: counterByRep.get(s.repId)?.lastAssignedAt
        ? counterByRep.get(s.repId)!.lastAssignedAt.toISOString()
        : null,
      rotationSeed: hashRepIdToSeed(s.repId),
    }))
    const ranked = rankReps(rankInputs)

    // 7. emit SKIP for ineligible reps not yet consumed this cycle (closes the cycle correctly)
    for (const r of ranked) {
      if (!r.isEligible && !servedSet.has(r.repId)) {
        await tx.insert(schema.assignmentEvents).values({
          repId: r.repId,
          eventType: 'SKIP',
          cycleNo: cycle.id,
          creditDelta: 0,
          queueSnapshot: ranked,
          idempotencyKey: `${input.idempotencyKey}-skip-${r.repId}`,
        })
        servedSet.add(r.repId)
      }
    }

    // 8. choose forced rep or first eligible-unserved
    const chosen = input.forcedRepId
      ? ranked.find((r) => r.repId === input.forcedRepId)
      : ranked.find((r) => r.isEligible && !servedSet.has(r.repId))

    // 9. duplicate-phone check — warn only, never block
    const dup = await tx.query.customer.findFirst({
      where: eq(schema.customer.phoneE164, input.customerPhoneE164),
    })

    const [customer] = await tx
      .insert(schema.customer)
      .values({ fullName: input.customerName, phoneE164: input.customerPhoneE164 })
      .onConflictDoUpdate({
        target: schema.customer.phoneE164,
        set: { fullName: input.customerName },
      })
      .returning()

    if (!chosen) {
      // 10. nobody eligible -> unassigned queue, never drop the lead
      const [lead] = await tx
        .insert(schema.lead)
        .values({
          customerId: customer.id,
          status: 'UNASSIGNED',
          businessDate: bDate,
          periodKey: pKey,
          createdBy: input.actorUserId,
        })
        .returning()
      await tx.insert(schema.unassignedQueue).values({ leadId: lead.id, reason: 'NO_ELIGIBLE_REP' })
      return { leadId: lead.id, assignedRepId: null, queueSnapshot: ranked, duplicatePhone: !!dup }
    }

    // 11. write lead + ASSIGN ledger event + bump counters + consume cycle slot, same transaction
    const [lead] = await tx
      .insert(schema.lead)
      .values({
        customerId: customer.id,
        assignedRepId: chosen.repId,
        status: 'ASSIGNED',
        businessDate: bDate,
        periodKey: pKey,
        createdBy: input.actorUserId,
      })
      .returning()

    await tx.insert(schema.assignmentEvents).values({
      leadId: lead.id,
      repId: chosen.repId,
      eventType: 'ASSIGN',
      cycleNo: cycle.id,
      creditDelta: 1,
      queueSnapshot: ranked,
      idempotencyKey: input.idempotencyKey,
    })
    await tx.insert(schema.rrCycleAssignments).values({ cycleId: cycle.id, repId: chosen.repId })
    await tx
      .insert(schema.repMonthCounters)
      .values({ repId: chosen.repId, periodKey: pKey, upsMtd: 1, upsToday: 1, lastAssignedAt: now })
      .onConflictDoUpdate({
        target: [schema.repMonthCounters.repId, schema.repMonthCounters.periodKey],
        set: {
          upsMtd: sql`${schema.repMonthCounters.upsMtd} + 1`,
          upsToday: sql`${schema.repMonthCounters.upsToday} + 1`,
          lastAssignedAt: now,
        },
      })

    // 12. cycle-completion check — close and reopen if every eligible rep has now been served
    const allEligible = ranked.filter((r) => r.isEligible)
    const nowServed = new Set([...servedSet, chosen.repId])
    if (allEligible.length > 0 && allEligible.every((r) => nowServed.has(r.repId))) {
      await tx.update(schema.rotationCycle).set({ closedAt: now }).where(eq(schema.rotationCycle.id, cycle.id))
      await tx.insert(schema.rotationCycle).values({})
    }

    return { leadId: lead.id, assignedRepId: chosen.repId, queueSnapshot: ranked, duplicatePhone: !!dup }
  })

  // 13. publish realtime event AFTER commit, never inside the transaction
  publishAssignment(result)
  return result
}
