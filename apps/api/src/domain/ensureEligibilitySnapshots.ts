import { eq, and } from 'drizzle-orm'
import { schema } from '@phoneup/db'
import { evaluateRepEligibility } from '../jobs/eligibility'

/**
 * Lazy fallback for a dead nightly eligibility job (spec §6): if no snapshot/status
 * exists yet for today, evaluate now, inside the same advisory-locked transaction as
 * the assignment that triggered it. If evaluation itself errors, fail open to ELIGIBLE
 * per spec §6 ("a store that can't distribute phone-ups can't sell cars") rather than
 * blocking the whole board.
 */
export async function ensureEligibilitySnapshots(tx: any, businessDate: string): Promise<void> {
  const policy = await tx.query.workRequirementPolicy.findFirst()
  const reps = await tx.select().from(schema.salesRep)

  for (const rep of reps) {
    const existing = await tx.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, rep.id), eq(schema.repDailyStatus.businessDate, businessDate)),
    })
    if (existing) continue

    if (!policy) {
      await tx.insert(schema.repDailyStatus).values({
        repId: rep.id,
        businessDate,
        status: 'ELIGIBLE',
        reason: 'fail-open: no work requirement policy configured',
        decidedBy: 'SYSTEM',
      })
      continue
    }

    try {
      await evaluateRepEligibility(tx, { repId: rep.id, businessDate, policyId: policy.id })
    } catch (err) {
      console.error(`eligibility evaluation failed for rep ${rep.id}, defaulting ELIGIBLE`, err)
      await tx.insert(schema.repDailyStatus).values({
        repId: rep.id,
        businessDate,
        status: 'ELIGIBLE',
        reason: 'fail-open: eligibility evaluation errored',
        decidedBy: 'SYSTEM',
      })
    }
  }
}
