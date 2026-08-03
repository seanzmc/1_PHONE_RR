import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDatesThroughSaturday, shiftDate } from './eligibility'
import {
  assertActivityMatchQuality,
  findUniqueRosterRep,
  indexRosterByNormalizedName,
  parseActivityCsv,
  type ImportSummary,
  type ParsedActivityRow,
} from './activityImport'
import { publishAssignment } from '../realtime/bus'
import { selectActiveReps } from '../domain/activeReps'
import {
  managerStatusBlocksSystemWrite,
  managerStatusSkipsActivityEvaluation,
} from '../domain/statusAuthority'

const ADVISORY_LOCK_KEY = 42_100_1
const PREVIEW_TOKEN_SECRET = randomBytes(32)
const PREVIEW_TOKEN_PATTERN = /^[a-f0-9]{128}$/

function isWellFormedPreviewToken(value: string): boolean {
  return value.length === 128 && PREVIEW_TOKEN_PATTERN.test(value)
}

export type ImportDecision = 'LOG_ONLY' | 'LOG_AND_DEACTIVATE'

export type EligibilityPreviewRep = {
  repId: string
  displayName: string
  evaluatedPriorWorkday: string
  callsFound: number
  minCallsRequired: number
  wouldBeStatus: 'ELIGIBLE' | 'INELIGIBLE'
  reason: string | null
  /** Whether this rep's number came from the uploaded report or an earlier imported day. */
  source: 'REPORT' | 'CARRY_FORWARD'
}

export type ActivityImportPreview = ImportSummary & {
  /** Date whose rotation eligibility the manager is deciding (normally today). */
  statusDate: string
  minCallsRequired: number
  eligibleRepsCount: number
  eligibleReps: EligibilityPreviewRep[]
  ineligibleReps: EligibilityPreviewRep[]
  notEvaluatedReps: Array<{ repId: string; displayName: string; reason: string }>
  /** Authenticated token for the report + policy + facts used. Commit rejects if any changed. */
  previewToken: string
}

export type CommitActivityImportInput = {
  csv: string
  businessDate: string
  statusDate: string
  previewToken: string
  decision: ImportDecision
  actorUserId: string
}

export type CommitActivityImportResult = ActivityImportPreview & {
  decision: ImportDecision
  deactivatedCount: number
}

type PrepareOptions = {
  statusDate: string
  policyId?: string
  previewNonce?: string
}

type ImportWrite = {
  repId: string
  calls: number
  sold: number
}

type PreparedImport = {
  preview: ActivityImportPreview
  writes: ImportWrite[]
  evaluations: EligibilityPreviewRep[]
  policyId: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Authenticate the reviewed fingerprint with a process-private key. The nonce keeps tokens
 * unique; the HMAC prevents a client from minting a valid token by reproducing public hashes.
 * A process restart intentionally expires outstanding previews so they must be reviewed again.
 */
export function createAuthenticatedPreviewToken(
  fingerprint: string,
  nonce = randomBytes(32).toString('hex'),
): string {
  const digest = createHmac('sha256', PREVIEW_TOKEN_SECRET)
    .update(nonce)
    .update('\0')
    .update(fingerprint)
    .digest('hex')
  return `${nonce}${digest}`
}

/** Constant-time comparison for fixed-length, lowercase hexadecimal preview tokens. */
export function previewTokensMatch(provided: string, expected: string): boolean {
  if (!isWellFormedPreviewToken(provided) || !isWellFormedPreviewToken(expected)) return false
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
}

function byRepId<T extends { repId: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.repId, row]))
}

/**
 * Side-effect-free preparation shared by preview and commit.
 *
 * It overlays the not-yet-saved report over existing activity in memory, preserving MANUAL
 * rows, then runs the same prior-workday rule the eligibility job uses. This is what makes
 * Cancel Entirely truthful: preview writes no metrics, snapshots, statuses, or audit event.
 */
async function prepareDailyActivity(
  tx: any,
  csv: string,
  reportBusinessDate: string,
  opts: PrepareOptions,
): Promise<PreparedImport> {
  if (reportBusinessDate > opts.statusDate) {
    throw new Error('report business date cannot be later than the eligibility status date')
  }
  const rows = parseActivityCsv(csv)
  if (rows.length === 0) throw new Error('the report contains no activity data rows')

  const policy = opts.policyId
    ? await tx.query.workRequirementPolicy.findFirst({
        where: eq(schema.workRequirementPolicy.id, opts.policyId),
      })
    : await tx.query.workRequirementPolicy.findFirst()
  if (!policy) throw new Error('no work requirement policy is configured')

  const reps = await selectActiveReps(tx)
  if (reps.length === 0) throw new Error('no sales reps are configured')
  const repIds = reps.map((rep: any) => rep.id)
  const repsByName = indexRosterByNormalizedName(reps)

  const existingReportRows = await tx.query.repDailyActivity.findMany({
    where: eq(schema.repDailyActivity.businessDate, reportBusinessDate),
  })
  const existingReportByRep = byRepId<any>(existingReportRows as any[])

  const incomingByRep = new Map<string, ParsedActivityRow>()
  const unmatchedNames: string[] = []
  const matchedRepIds = new Set<string>()
  for (const row of rows) {
    const rep = findUniqueRosterRep(repsByName, row.userName)
    if (!rep) {
      unmatchedNames.push(row.userName)
      continue
    }
    matchedRepIds.add(rep.id)
    incomingByRep.set(rep.id, row)
  }
  assertActivityMatchQuality(rows.length, matchedRepIds.size)

  const manualRowsPreserved: string[] = []
  const writes: ImportWrite[] = []
  const effectiveReportByRep = new Map<string, { calls: number; sold: number; source: string }>()
  for (const rep of reps) {
    const existing = existingReportByRep.get(rep.id)
    const incoming = incomingByRep.get(rep.id)
    if (existing?.source === 'MANUAL') {
      manualRowsPreserved.push(rep.displayName)
      effectiveReportByRep.set(rep.id, {
        calls: existing.calls,
        sold: existing.sold,
        source: 'MANUAL',
      })
      continue
    }
    // A rep absent from the export made no calls that day: the CRM omits reps with no
    // activity. The 0 is written as a real row rather than left blank so the manager can
    // correct it from the rep's activity log if the export was incomplete — a correction
    // writes source='MANUAL' and survives re-import.
    const calls = incoming?.calls ?? 0
    const sold = incoming?.sold ?? 0
    writes.push({ repId: rep.id, calls, sold })
    effectiveReportByRep.set(rep.id, { calls, sold, source: 'IMPORT' })
  }

  const startDate = shiftDate(opts.statusDate, -policy.maxPriorWorkdayAge)
  const shifts = await tx
    .select()
    .from(schema.repShift)
    .where(
      and(
        inArray(schema.repShift.repId, repIds),
        gte(schema.repShift.businessDate, startDate),
        lte(schema.repShift.businessDate, opts.statusDate),
      ),
    )
  const shiftByKey = new Map<string, any>(
    shifts.map((shift: any) => [`${shift.repId}:${shift.businessDate}`, shift]),
  )

  const activityWindow = await tx
    .select()
    .from(schema.repDailyActivity)
    .where(
      and(
        inArray(schema.repDailyActivity.repId, repIds),
        gte(schema.repDailyActivity.businessDate, startDate),
        lte(schema.repDailyActivity.businessDate, opts.statusDate),
      ),
    )
  const activityByKey = new Map<string, any>(
    activityWindow.map((activity: any) => [`${activity.repId}:${activity.businessDate}`, activity]),
  )

  const weekDates = businessDatesThroughSaturday(opts.statusDate)
  const statusEndDate = weekDates.at(-1) ?? opts.statusDate
  const relevantStatuses = await tx
    .select()
    .from(schema.repDailyStatus)
    .where(
      and(
        inArray(schema.repDailyStatus.repId, repIds),
        gte(schema.repDailyStatus.businessDate, opts.statusDate),
        lte(schema.repDailyStatus.businessDate, statusEndDate),
      ),
    )
  const todayStatuses = relevantStatuses.filter((status: any) => status.businessDate === opts.statusDate)
  const statusByRep = byRepId<any>(todayStatuses as any[])

  const evaluations: EligibilityPreviewRep[] = []
  const notEvaluatedReps: ActivityImportPreview['notEvaluatedReps'] = []

  for (const rep of reps) {
    const todayShift = shiftByKey.get(`${rep.id}:${opts.statusDate}`)
    if (!todayShift) {
      notEvaluatedReps.push({ repId: rep.id, displayName: rep.displayName, reason: 'no schedule found for today' })
      continue
    }
    if (todayShift.kind !== 'WORK') {
      notEvaluatedReps.push({
        repId: rep.id,
        displayName: rep.displayName,
        reason: `${todayShift.kind.toLowerCase()} today`,
      })
      continue
    }

    const existingStatus = statusByRep.get(rep.id)
    if (managerStatusSkipsActivityEvaluation(existingStatus)) {
      notEvaluatedReps.push({
        repId: rep.id,
        displayName: rep.displayName,
        reason: 'already inactive by manager decision',
      })
      continue
    }

    let priorWorkday: string | null = null
    for (let back = 1; back <= policy.maxPriorWorkdayAge; back++) {
      const candidate = shiftDate(opts.statusDate, -back)
      if (shiftByKey.get(`${rep.id}:${candidate}`)?.kind === 'WORK') {
        priorWorkday = candidate
        break
      }
    }
    if (!priorWorkday) {
      notEvaluatedReps.push({
        repId: rep.id,
        displayName: rep.displayName,
        reason: 'no prior workday within grace window',
      })
      continue
    }

    // A rep is judged on THEIR prior workday, which is not always the report's date — someone
    // off yesterday is carried forward to the last day they actually worked. The report can
    // only supply that day when the two coincide.
    const reportSuppliesPriorDay = priorWorkday === reportBusinessDate
    const activity = reportSuppliesPriorDay
      ? effectiveReportByRep.get(rep.id)
      : activityByKey.get(`${rep.id}:${priorWorkday}`)

    // A carry-forward day with no import at all is missing data, not a zero — that is the
    // IMPORT_LATE fail-open. Absence from a report that DID land is a real zero.
    if (!reportSuppliesPriorDay && !activity) {
      notEvaluatedReps.push({
        repId: rep.id,
        displayName: rep.displayName,
        reason: `IMPORT_LATE: no activity import for ${priorWorkday}`,
      })
      continue
    }
    const callsFound = activity?.calls ?? 0
    const wouldBeStatus = callsFound >= policy.minCalls ? 'ELIGIBLE' : 'INELIGIBLE'
    const reason =
      wouldBeStatus === 'INELIGIBLE'
        ? `WEEK_DQ: ${callsFound} calls on ${priorWorkday}, ${policy.minCalls} required`
        : null
    evaluations.push({
      repId: rep.id,
      displayName: rep.displayName,
      evaluatedPriorWorkday: priorWorkday,
      callsFound,
      minCallsRequired: policy.minCalls,
      wouldBeStatus,
      reason,
      source: reportSuppliesPriorDay ? 'REPORT' : 'CARRY_FORWARD',
    })
  }

  const sortByName = (a: { displayName: string }, b: { displayName: string }) =>
    a.displayName.localeCompare(b.displayName)
  const eligibleReps = evaluations.filter((e) => e.wouldBeStatus === 'ELIGIBLE').sort(sortByName)
  const ineligibleReps = evaluations.filter((e) => e.wouldBeStatus === 'INELIGIBLE').sort(sortByName)
  notEvaluatedReps.sort(sortByName)

  const summary: ImportSummary = {
    businessDate: reportBusinessDate,
    rowsParsed: rows.length,
    repsMatched: matchedRepIds.size,
    repsMissingFromFile: reps.filter((rep: any) => !matchedRepIds.has(rep.id)).map((rep: any) => rep.displayName),
    unmatchedNames,
    manualRowsPreserved,
  }

  // Include every mutable fact that can change the decision between preview and commit.
  // Commit recomputes this inside its transaction; mismatch means the manager must review
  // the new count instead of applying an obsolete Yes.
  const fingerprint = {
    reportHash: sha256(`${reportBusinessDate}\0${csv}`),
    statusDate: opts.statusDate,
    policy: { id: policy.id, minCalls: policy.minCalls, maxAge: policy.maxPriorWorkdayAge },
    effectiveReport: [...effectiveReportByRep.entries()].sort(([a], [b]) => a.localeCompare(b)),
    statuses: relevantStatuses
      .map((status: any) => ({
        repId: status.repId,
        businessDate: status.businessDate,
        status: status.status,
        reason: status.reason,
        decidedBy: status.decidedBy,
      }))
      .sort((a: any, b: any) =>
        `${a.repId}:${a.businessDate}`.localeCompare(`${b.repId}:${b.businessDate}`),
      ),
    evaluations: [...evaluations].sort((a, b) => a.repId.localeCompare(b.repId)),
    notEvaluated: [...notEvaluatedReps].sort((a, b) => a.repId.localeCompare(b.repId)),
  }

  const previewNonce = opts.previewNonce ?? randomBytes(32).toString('hex')
  const previewToken = createAuthenticatedPreviewToken(JSON.stringify(fingerprint), previewNonce)

  return {
    writes,
    evaluations,
    policyId: policy.id,
    preview: {
      ...summary,
      statusDate: opts.statusDate,
      minCallsRequired: policy.minCalls,
      eligibleRepsCount: eligibleReps.length,
      eligibleReps,
      ineligibleReps,
      notEvaluatedReps,
      previewToken,
    },
  }
}

export async function previewDailyActivity(
  db: DB,
  csv: string,
  businessDate: string,
  opts: PrepareOptions,
): Promise<ActivityImportPreview> {
  return (await prepareDailyActivity(db, csv, businessDate, opts)).preview
}

export async function commitDailyActivity(
  db: DB,
  input: CommitActivityImportInput,
  opts: { policyId?: string } = {},
): Promise<CommitActivityImportResult> {
  const result = await db.transaction(async (tx) => {
    // Both decisions write activity. Serialize with corrections, policy/schedule changes,
    // eligibility, assign, void, and overrides so token validation and writes are atomic.
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    if (!isWellFormedPreviewToken(input.previewToken)) {
      throw new Error('PREVIEW_STALE: invalid preview token; process the report again')
    }

    const priorCommit = await tx
      .select({ id: schema.auditEvents.id })
      .from(schema.auditEvents)
      .where(
        and(
          eq(schema.auditEvents.action, 'activity.import'),
          sql`${schema.auditEvents.after}->>'previewToken' = ${input.previewToken}`,
        ),
      )
      .limit(1)
    if (priorCommit.length > 0) {
      throw new Error('PREVIEW_ALREADY_COMMITTED: this reviewed import decision was already saved')
    }

    const prepared = await prepareDailyActivity(tx, input.csv, input.businessDate, {
      statusDate: input.statusDate,
      policyId: opts.policyId,
      previewNonce: input.previewToken.slice(0, 64),
    })
    if (!previewTokensMatch(input.previewToken, prepared.preview.previewToken)) {
      throw new Error('PREVIEW_STALE: report, policy, or eligibility facts changed; review the new preview')
    }

    for (const row of prepared.writes) {
      await tx
        .insert(schema.repDailyActivity)
        .values({
          repId: row.repId,
          businessDate: input.businessDate,
          calls: row.calls,
          sold: row.sold,
          source: 'IMPORT',
          importedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.repDailyActivity.repId, schema.repDailyActivity.businessDate],
          set: {
            calls: row.calls,
            sold: row.sold,
            source: 'IMPORT',
            importedAt: new Date(),
          },
          setWhere: sql`${schema.repDailyActivity.source} <> 'MANUAL'`,
        })
    }

    // A decision to log the numbers still records the calculation. It only declines the
    // status writes. This keeps the audit trail of what the manager saw without deactivating.
    for (const evaluation of prepared.evaluations) {
      await tx.insert(schema.eligibilitySnapshot).values({
        repId: evaluation.repId,
        businessDate: input.statusDate,
        evaluatedPriorWorkday: evaluation.evaluatedPriorWorkday,
        callsFound: evaluation.callsFound,
        minCallsRequired: evaluation.minCallsRequired,
        wouldBeStatus: evaluation.wouldBeStatus,
        reason: evaluation.reason,
        policyId: prepared.policyId,
      })
    }

    let deactivatedCount = 0
    if (input.decision === 'LOG_AND_DEACTIVATE') {
      for (const evaluation of prepared.evaluations) {
        if (evaluation.wouldBeStatus === 'ELIGIBLE') continue
        deactivatedCount++
        for (const date of businessDatesThroughSaturday(input.statusDate)) {
          await upsertSystemStatus(tx, evaluation.repId, date, 'INELIGIBLE', evaluation.reason)
        }
      }
    }

    const firstRepId = (await selectActiveReps(tx))[0]?.id
    if (!firstRepId) throw new Error('no sales rep available for activity import audit entity')
    await tx.insert(schema.auditEvents).values({
      actorUserId: input.actorUserId,
      action: 'activity.import',
      entityType: 'rep_daily_activity',
      entityId: firstRepId,
      before: null,
      after: {
        businessDate: prepared.preview.businessDate,
        statusDate: prepared.preview.statusDate,
        rowsParsed: prepared.preview.rowsParsed,
        repsMatched: prepared.preview.repsMatched,
        repsMissingFromFile: prepared.preview.repsMissingFromFile.length,
        unmatchedNames: prepared.preview.unmatchedNames,
        manualRowsPreserved: prepared.preview.manualRowsPreserved,
        ineligibleReps: prepared.preview.ineligibleReps.length,
        decision: input.decision,
        deactivatedCount,
        previewToken: prepared.preview.previewToken,
      },
    })

    return {
      ...prepared.preview,
      decision: input.decision,
      deactivatedCount,
    }
  })

  if (input.decision === 'LOG_AND_DEACTIVATE') {
    // Existing board clients refresh on the single realtime channel. Status is still read
    // exclusively from rep_daily_status; this only prompts them to re-fetch it now.
    publishAssignment({ type: 'ELIGIBILITY_UPDATED', statusDate: input.statusDate })
  }

  return result
}

async function upsertSystemStatus(
  tx: any,
  repId: string,
  statusDate: string,
  status: 'ELIGIBLE' | 'INELIGIBLE',
  reason: string | null,
): Promise<void> {
  const existing = await tx.query.repDailyStatus.findFirst({
    where: and(
      eq(schema.repDailyStatus.repId, repId),
      eq(schema.repDailyStatus.businessDate, statusDate),
    ),
  })
  if (managerStatusBlocksSystemWrite(existing, status, 'ACTIVITY')) return
  if (existing) {
    await tx
      .update(schema.repDailyStatus)
      .set({ status, reason, decidedBy: 'SYSTEM', updatedAt: new Date() })
      .where(eq(schema.repDailyStatus.id, existing.id))
    return
  }
  await tx.insert(schema.repDailyStatus).values({
    repId,
    businessDate: statusDate,
    status,
    reason,
    decidedBy: 'SYSTEM',
  })
}
