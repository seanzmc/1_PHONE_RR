import { sql, eq, and, inArray } from 'drizzle-orm'
import type { DB } from '@phoneup/db'
import { schema } from '@phoneup/db'
import { businessDate, isOverrideNoOp, type CurrentRepStatus, type OverrideTarget } from '@phoneup/core'
import { ADVISORY_LOCK_KEY, applyOverrideStatus } from './overrideStatus'
import { publishAssignment } from '../realtime/bus'

export type BulkOverrideStatusInput = {
  repIds: string[]
  status: OverrideTarget
  reasonCode: string
  reasonNote: string
  actorUserId: string
}

export type BulkOverrideStatusResult = {
  applied: string[]
  skipped: string[]
}

/**
 * Apply one status decision to many reps in a single transaction under a single
 * `pg_advisory_xact_lock`.
 *
 * Deliberately not N calls to `overrideStatus` from the client: status changes reorder the
 * rotation, so N transactions would make a partial apply reachable and would take and
 * release the lock N times while a BDC agent waits to assign a lead.
 *
 * The no-op rule is re-checked HERE rather than trusted from the client. The Staff List's
 * roster can be seconds stale, and the same lock that serializes this batch is what makes
 * the re-read authoritative.
 */
export async function bulkOverrideStatus(
  db: DB,
  input: BulkOverrideStatusInput,
): Promise<BulkOverrideStatusResult> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

    // A rep with no `rep_daily_status` row is, by the shared no-op rule, treated as already
    // inactive — that's correct for a real rep who just hasn't had eligibility computed yet.
    // It would also silently swallow a repId that doesn't exist at all (FORCE_INACTIVE would
    // skip it rather than fail), which is the wrong failure mode for a batch that should
    // reject as a whole. Check existence up front so an unknown id fails loudly and rolls
    // back the transaction, instead of being mistaken for "already at the target status."
    const knownReps = await tx.query.salesRep.findMany({
      where: inArray(schema.salesRep.id, input.repIds),
    })
    if (knownReps.length !== input.repIds.length) {
      const knownIds = new Set(knownReps.map((r: any) => r.id))
      const unknown = input.repIds.filter((id) => !knownIds.has(id))
      throw new Error(`bulkOverrideStatus: unknown repId(s): ${unknown.join(', ')}`)
    }

    const today = businessDate(new Date())
    const rows = await tx.query.repDailyStatus.findMany({
      where: and(
        inArray(schema.repDailyStatus.repId, input.repIds),
        eq(schema.repDailyStatus.businessDate, today),
      ),
    })
    const statusByRep = new Map(rows.map((row: any) => [row.repId, row]))

    const applied: string[] = []
    const skipped: string[] = []

    for (const repId of input.repIds) {
      const row: any = statusByRep.get(repId)
      const current: CurrentRepStatus = {
        isEligible: row?.status === 'ELIGIBLE',
        decidedBy: row?.decidedBy ?? null,
      }

      if (isOverrideNoOp(input.status, current)) {
        skipped.push(repId)
        continue
      }

      await applyOverrideStatus(tx, {
        repId,
        status: input.status,
        reasonCode: input.reasonCode,
        reasonNote: input.reasonNote,
        actorUserId: input.actorUserId,
      })
      applied.push(repId)
    }

    return { applied, skipped }
  })

  if (result.applied.length > 0) {
    publishAssignment({ type: 'ELIGIBILITY_UPDATED', statusDate: businessDate(new Date()) })
  }
  return result
}
