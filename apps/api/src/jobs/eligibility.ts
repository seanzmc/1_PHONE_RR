import cron from 'node-cron'
import { eq, and, inArray, gte, sql } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate } from '@phoneup/core'
import { selectActiveReps } from '../domain/activeReps'
import { managerStatusBlocksSystemWrite, managerStatusSkipsActivityEvaluation } from '../domain/statusAuthority'

const ADVISORY_LOCK_KEY = 42_100_1

export function shiftDate(dateStr: string, deltaDays: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

/** 0=Sunday..6=Saturday for a YYYY-MM-DD business date (tz-independent by construction). */
export function dayOfWeek(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay()
}

/**
 * The business week is Monday–Saturday; Sunday (weekday 0) is closed, hardcoded.
 * Returns every business date from `fromDate` through that week's Saturday, inclusive.
 * A DQ computed on Monday covers Mon–Sat; one computed on Saturday covers a single day.
 */
export function businessDatesThroughSaturday(fromDate: string): string[] {
  const dates: string[] = []
  let cursor = fromDate
  for (let i = 0; i < 7; i++) {
    const dow = dayOfWeek(cursor)
    if (dow !== 0) dates.push(cursor) // Sunday is never a business date
    if (dow === 6) break // Saturday closes the week
    cursor = shiftDate(cursor, 1)
  }
  return dates
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
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    const existing = await tx.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, input.repId), eq(schema.repDailyStatus.businessDate, input.businessDate)),
    })
    if (managerStatusSkipsActivityEvaluation(existing)) return

    const policy = await tx.query.workRequirementPolicy.findFirst({
      where: eq(schema.workRequirementPolicy.id, input.policyId),
    })
    if (!policy) throw new Error(`policy ${input.policyId} not found`)

    // fail-safe: no shift scheduled for today at all -> CONFIGURATION_ERROR, never silently ELIGIBLE.
    // The weekly shift materializer (materializeShifts) is what keeps this from being the normal case.
    const todayShift = await tx.query.repShift.findFirst({
      where: and(eq(schema.repShift.repId, input.repId), eq(schema.repShift.businessDate, input.businessDate)),
    })
    if (!todayShift) {
      await upsertStatus(tx, input.repId, input.businessDate, 'CONFIGURATION_ERROR', 'no schedule found for today')
      return
    }

    // A non-WORK day is ineligible-for-that-reason, but it must NOT erase a WEEK_DQ reason
    // already written for the day. Manager status retains precedence for this non-activity write.
    if (todayShift.kind !== 'WORK') {
      const dqReason = existing?.reason?.startsWith('WEEK_DQ') ? ` (${existing.reason})` : ''
      await upsertStatus(
        tx,
        input.repId,
        input.businessDate,
        'INELIGIBLE',
        `${todayShift.kind.toLowerCase()}${dqReason}`,
      )
      return
    }

    const priorWorkday = await findPreviousWorkday(tx, input.repId, input.businessDate, policy.maxPriorWorkdayAge)
    if (!priorWorkday) {
      // no qualifying prior workday within the bound (new hire / long absence) -> exempt, stays ELIGIBLE
      await upsertStatus(tx, input.repId, input.businessDate, 'ELIGIBLE', 'no prior workday within grace window')
      return
    }

    // Import lateness check: if NOBODY has a rep_daily_activity row for that day, the import
    // hasn't landed yet — treat the rep as ELIGIBLE and skip. Never auto-DQ on a missing import.
    const anyImportForDay = await tx.query.repDailyActivity.findFirst({
      where: eq(schema.repDailyActivity.businessDate, priorWorkday),
    })
    if (!anyImportForDay) {
      await upsertStatus(tx, input.repId, input.businessDate, 'ELIGIBLE', 'IMPORT_LATE: no activity import for prior workday yet')
      return
    }

    // Calls come from the aggregate import (design pass §H). A roster rep with no row in the
    // file legitimately registers 0 calls — that is a real signal, not missing data.
    const activity = await tx.query.repDailyActivity.findFirst({
      where: and(
        eq(schema.repDailyActivity.repId, input.repId),
        eq(schema.repDailyActivity.businessDate, priorWorkday),
      ),
    })
    const callsFound = activity?.calls ?? 0
    const wouldBeStatus = callsFound >= policy.minCalls ? 'ELIGIBLE' : 'INELIGIBLE'
    const dqReason = `WEEK_DQ: ${callsFound} calls on ${priorWorkday}, ${policy.minCalls} required`

    await tx.insert(schema.eligibilitySnapshot).values({
      repId: input.repId,
      businessDate: input.businessDate,
      evaluatedPriorWorkday: priorWorkday,
      callsFound,
      minCallsRequired: policy.minCalls,
      wouldBeStatus,
      reason: wouldBeStatus === 'INELIGIBLE' ? dqReason : null,
      policyId: policy.id,
    })

    // SHADOW mode never actually disqualifies — compute + log only (CLAUDE.md).
    // The thresholds are what's being calibrated, so the mechanism ships inert first.
    if (policy.enforcementMode !== 'ENFORCE') {
      await upsertStatus(
        tx,
        input.repId,
        input.businessDate,
        'ELIGIBLE',
        wouldBeStatus === 'INELIGIBLE'
          ? `SHADOW: would be INELIGIBLE (${callsFound}/${policy.minCalls} calls on ${priorWorkday})`
          : null,
      )
      return
    }

    if (wouldBeStatus === 'ELIGIBLE') {
      await upsertStatus(tx, input.repId, input.businessDate, 'ELIGIBLE', null)
      return
    }

    // Week suspension: under the minimum on the evaluated prior workday means ineligible for the
    // REST OF THE WEEK. Implemented as status writes only — the ranking algorithm still reads
    // exactly rep_daily_status and gains no branch (CLAUDE.md).
    //
    // Future rows are written decidedBy='SYSTEM', so the nightly override guard above leaves a
    // manager's later reactivation alone. The write never crosses into next week, so "resets every
    // Monday" is automatic and needs no separate reset job.
    for (const date of businessDatesThroughSaturday(input.businessDate)) {
      await upsertStatus(tx, input.repId, date, 'INELIGIBLE', dqReason, 'ACTIVITY')
    }
  })
}

async function upsertStatus(
  tx: any,
  repId: string,
  businessDateStr: string,
  status: 'ELIGIBLE' | 'INELIGIBLE' | 'CONFIGURATION_ERROR',
  reason: string | null,
  source: 'ACTIVITY' | 'OTHER' = 'OTHER',
): Promise<void> {
  const existing = await tx.query.repDailyStatus.findFirst({
    where: and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, businessDateStr)),
  })
  if (existing) {
    // A reviewed activity failure writes the whole remaining weekly tail up front. Later
    // background passes may collect fresher evidence, but none of their automatic ELIGIBLE
    // branches may shorten that suspension. Explicit manager reactivation uses the override
    // path instead and remains the sole authority that clears it.
    if (
      status === 'ELIGIBLE' &&
      existing.status === 'INELIGIBLE' &&
      existing.decidedBy === 'SYSTEM' &&
      existing.reason?.includes('WEEK_DQ')
    ) return
    if (managerStatusBlocksSystemWrite(existing, status, source)) return
    await tx
      .update(schema.repDailyStatus)
      .set({ status, reason, decidedBy: 'SYSTEM', updatedAt: new Date() })
      .where(eq(schema.repDailyStatus.id, existing.id))
  } else {
    await tx.insert(schema.repDailyStatus).values({ repId, businessDate: businessDateStr, status, reason, decidedBy: 'SYSTEM' })
  }
}

/**
 * Materialize `rep_shift` rows ~14 days ahead (design pass §I):
 *   kind='OFF'  where the weekday is a recurring day off, the weekday is Sunday, or the
 *               date is a store_closure
 *   kind='WORK' otherwise
 *
 * A manually-set kind (PTO / SICK / TRAINING / SUSPENDED, or a manager-set OFF/WORK) always
 * wins: this generator only ever INSERTS missing rows and updates rows it previously
 * generated, and it never rewrites a past date — past dates are eligibility evidence.
 */
const GENERATED_KINDS = new Set(['WORK', 'OFF'])

export type MaterializeShiftsOptions = { fromDate?: string; days?: number; repIds?: string[] }

/** Caller must already hold the rotation advisory lock in this transaction. */
export async function materializeShiftsLocked(
  tx: any,
  opts: MaterializeShiftsOptions = {},
): Promise<{ inserted: number; updated: number }> {
  const fromDate = opts.fromDate ?? businessDate(new Date())
  const days = opts.days ?? 14
  const activeReps = await selectActiveReps(tx)
  const requested = opts.repIds?.length ? new Set(opts.repIds) : null
  const reps = requested ? activeReps.filter((rep: any) => requested.has(rep.id)) : activeReps
  if (reps.length === 0) return { inserted: 0, updated: 0 }

  const repIds = reps.map((r: any) => r.id)
  const daysOff = await tx
    .select()
    .from(schema.repRecurringDayOff)
    .where(inArray(schema.repRecurringDayOff.repId, repIds))
  const offByRep = new Map<string, Set<number>>()
  for (const row of daysOff) {
    if (!offByRep.has(row.repId)) offByRep.set(row.repId, new Set())
    offByRep.get(row.repId)!.add(row.dayOfWeek)
  }

  const dates = Array.from({ length: days }, (_, i) => shiftDate(fromDate, i))
  const closures = await tx
    .select()
    .from(schema.storeClosure)
    .where(inArray(schema.storeClosure.closureDate, dates))
  const closureDates = new Set(closures.map((c: any) => c.closureDate))
  const existing = await tx
    .select()
    .from(schema.repShift)
    .where(and(inArray(schema.repShift.repId, repIds), gte(schema.repShift.businessDate, fromDate)))
  const existingByKey = new Map<string, any>(existing.map((s: any) => [`${s.repId}:${s.businessDate}`, s]))

  let inserted = 0
  let updated = 0
  for (const rep of reps) {
    const repOff = offByRep.get(rep.id) ?? new Set<number>()
    for (const date of dates) {
      const dow = dayOfWeek(date)
      // Sunday is closed for everyone — hardcoded, no config surface, and it must not
      // consume one of a rep's recurring day-off entries.
      const isOff = dow === 0 || repOff.has(dow) || closureDates.has(date)
      const kind = isOff ? 'OFF' : 'WORK'
      const prior = existingByKey.get(`${rep.id}:${date}`)
      if (!prior) {
        await tx.insert(schema.repShift).values({ repId: rep.id, businessDate: date, kind })
        inserted++
        continue
      }
      // a manually-set PTO/SICK/TRAINING/SUSPENDED row survives re-materialization
      if (!GENERATED_KINDS.has(prior.kind)) continue
      if (prior.kind === kind) continue
      await tx.update(schema.repShift).set({ kind }).where(eq(schema.repShift.id, prior.id))
      updated++
    }
  }

  return { inserted, updated }
}

export async function materializeShifts(db: DB, opts: MaterializeShiftsOptions = {}) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)
    return materializeShiftsLocked(tx, opts)
  })
}

export async function runEligibilityJob(db: DB): Promise<void> {
  const today = businessDate(new Date())
  const policy = await db.query.workRequirementPolicy.findFirst()
  if (!policy) return
  const reps = await selectActiveReps(db)
  for (const rep of reps) {
    await evaluateRepEligibility(db, { repId: rep.id, businessDate: today, policyId: policy.id })
  }
}

export function scheduleEligibilityJob(db: DB): void {
  // runs early store-local time, before shift start (spec §6)
  cron.schedule('0 8 * * *', () => runEligibilityJob(db), { timezone: 'America/New_York' })
}

export function scheduleShiftMaterializationJob(db: DB): void {
  // weekly, Sunday 03:00 store-local — keeps ~14 days of rep_shift rows ahead of the
  // eligibility job so CONFIGURATION_ERROR stops being the normal case.
  cron.schedule('0 3 * * 0', () => materializeShifts(db), { timezone: 'America/New_York' })
}
