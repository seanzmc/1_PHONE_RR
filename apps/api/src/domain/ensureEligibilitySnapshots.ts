import { eq, and } from 'drizzle-orm'
import { schema } from '@phoneup/db'

/**
 * Stub for Task 6 — replaced with the real eligibility evaluation in Task 10.
 * Fail-open per spec §6: if no rep_daily_status row exists yet for a rep/day
 * (nightly job hasn't run, or died), default that rep to ELIGIBLE rather than
 * blocking assignment.
 */
export async function ensureEligibilitySnapshots(tx: any, businessDate: string): Promise<void> {
  const reps = await tx.select().from(schema.salesRep)
  for (const rep of reps) {
    const existing = await tx.query.repDailyStatus.findFirst({
      where: and(eq(schema.repDailyStatus.repId, rep.id), eq(schema.repDailyStatus.businessDate, businessDate)),
    })
    if (!existing) {
      await tx.insert(schema.repDailyStatus).values({
        repId: rep.id,
        businessDate,
        status: 'ELIGIBLE',
        reason: 'fail-open: no eligibility evaluation yet for this date',
        decidedBy: 'SYSTEM',
      })
    }
  }
}
