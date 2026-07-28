import cron from 'node-cron'
import { eq, and, lte, gte, sql } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'

function shiftDate(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

export type EvaluateInput = { repId: string; businessDate: string; policyId: string }

async function findPreviousWorkday(
  tx: any,
  repId: string,
  fromBusinessDate: string,
  maxAge: number,
): Promise<string | null> {
  for (let back = 1; back <= maxAge; back++) {
    const candidate = shiftDate(fromBusinessDate, -back)
    const shift = await tx.query.repShift.findFirst({
      where: and(eq(schema.repShift.repId, repId), eq(schema.repShift.businessDate, candidate)),
    })
    if (shift?.kind === 'WORK') return candidate
  }
  return null
}

export async function evaluateRepEligibility(db: DB, input: EvaluateInput): Promise<void> {
  await db.transaction(async (tx) => {
    // override always wins — never overwrite a manager-decided status
    const existing = await tx.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, input.repId), eq(schema.repDailyStatus.businessDate, input.businessDate)),
    })
    if (existing?.decidedBy === 'MANAGER_OVERRIDE') return

    const policy = await tx.query.workRequirementPolicy.findFirst({
      where: eq(schema.workRequirementPolicy.id, input.policyId),
    })
    if (!policy) throw new Error(`policy ${input.policyId} not found`)

    // fail-safe: no shift scheduled for today at all -> CONFIGURATION_ERROR, never silently ELIGIBLE
    const todayShift = await tx.query.repShift.findFirst({
      where: and(eq(schema.repShift.repId, input.repId), eq(schema.repShift.businessDate, input.businessDate)),
    })
    if (!todayShift) {
      await upsertStatus(tx, input.repId, input.businessDate, 'CONFIGURATION_ERROR', 'no schedule found for today')
      return
    }

    const priorWorkday = await findPreviousWorkday(tx, input.repId, input.businessDate, policy.maxPriorWorkdayAge)
    if (!priorWorkday) {
      // no qualifying prior workday within the bound (new hire / long absence) -> exempt, stays ELIGIBLE
      await upsertStatus(tx, input.repId, input.businessDate, 'ELIGIBLE', 'no prior workday within grace window')
      return
    }

    // CRM import lateness check: if nobody at all has a CRM_IMPORT row for that day,
    // treat the rep as ELIGIBLE and skip evaluation — never auto-DQ on a missing import (spec §7).
    const anyImportForDay = await tx.query.leadActivity.findFirst({
      where: eq(schema.leadActivity.businessDate, priorWorkday),
    })
    if (!anyImportForDay) {
      await upsertStatus(tx, input.repId, input.businessDate, 'ELIGIBLE', 'IMPORT_LATE: no CRM import for prior workday yet')
      return
    }

    const calls = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.leadActivity)
      .where(and(eq(schema.leadActivity.repId, input.repId), eq(schema.leadActivity.businessDate, priorWorkday)))
    const callsFound = calls[0]?.count ?? 0
    const wouldBeStatus = callsFound >= policy.minCalls ? 'ELIGIBLE' : 'INELIGIBLE'

    await tx.insert(schema.eligibilitySnapshot).values({
      repId: input.repId,
      businessDate: input.businessDate,
      evaluatedPriorWorkday: priorWorkday,
      callsFound,
      minCallsRequired: policy.minCalls,
      wouldBeStatus,
      reason: wouldBeStatus === 'INELIGIBLE' ? `${callsFound} calls, ${policy.minCalls} required` : null,
      policyId: policy.id,
    })

    // SHADOW mode never actually disqualifies — compute + log only (spec §6.5, CLAUDE.md).
    const resolvedStatus = policy.enforcementMode === 'ENFORCE' ? wouldBeStatus : 'ELIGIBLE'
    const reason =
      policy.enforcementMode === 'ENFORCE'
        ? (wouldBeStatus === 'INELIGIBLE' ? `${callsFound} calls, ${policy.minCalls} required` : null)
        : (wouldBeStatus === 'INELIGIBLE' ? `SHADOW: would be INELIGIBLE (${callsFound}/${policy.minCalls} calls)` : null)

    await upsertStatus(tx, input.repId, input.businessDate, resolvedStatus, reason)
  })
}

async function upsertStatus(
  tx: any,
  repId: string,
  businessDateStr: string,
  status: 'ELIGIBLE' | 'INELIGIBLE' | 'CONFIGURATION_ERROR',
  reason: string | null,
): Promise<void> {
  const existing = await tx.query.repDailyStatus.findFirst({
    where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, businessDateStr)),
  })
  if (existing) {
    await tx
      .update(schema.repDailyStatus)
      .set({ status, reason, decidedBy: 'SYSTEM', updatedAt: new Date() })
      .where(eq(schema.repDailyStatus.id, existing.id))
  } else {
    await tx.insert(schema.repDailyStatus).values({ repId, businessDate: businessDateStr, status, reason, decidedBy: 'SYSTEM' })
  }
}

export async function runEligibilityJob(db: DB): Promise<void> {
  const today = businessDate(new Date())
  const policy = await db.query.workRequirementPolicy.findFirst()
  if (!policy) return
  const reps = await db.select().from(schema.salesRep)
  for (const rep of reps) {
    await evaluateRepEligibility(db, { repId: rep.id, businessDate: today, policyId: policy.id })
  }
}

export function scheduleEligibilityJob(db: DB): void {
  // runs early store-local time, before shift start (spec §6)
  cron.schedule('0 8 * * *', () => runEligibilityJob(db), { timezone: 'America/New_York' })
}
