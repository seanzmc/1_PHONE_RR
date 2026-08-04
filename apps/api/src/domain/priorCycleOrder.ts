import { asc, desc, eq, isNotNull } from 'drizzle-orm'
import { schema } from '@phoneup/db'

/**
 * Position each rep held in the most recently completed cycle, keyed by rep id.
 *
 * A new cycle restarts the rotation in this order rather than re-sorting by monthly
 * totals, so the board's Served This Round order carries across the cycle boundary.
 *
 * Every surface that ranks reps must use this — `assignLead` (who gets the lead),
 * `skipLead` (who gets it when the first rep passes) and `board.roster` (who the team
 * is told is next). Three separate copies of the query is how those three answers
 * drift apart.
 *
 * Reps absent from the map — out sick, reactivated mid-cycle, newly hired, or had their
 * assignment voided — are deliberately ranked *ahead* of everyone in it; see the
 * `priorCycleOrder` comparator in `packages/core/src/ranking.ts`.
 */
export async function loadPriorCycleOrder(executor: any): Promise<Map<string, number>> {
  const priorCycle = await executor.query.rotationCycle.findFirst({
    where: isNotNull(schema.rotationCycle.closedAt),
    orderBy: [desc(schema.rotationCycle.closedAt)],
  })
  if (!priorCycle) return new Map<string, number>()

  const served = await executor.query.rrCycleAssignments.findMany({
    where: eq(schema.rrCycleAssignments.cycleId, priorCycle.id),
    // Match the Served This Round display order, including a deterministic tie-break.
    orderBy: [asc(schema.rrCycleAssignments.assignedAt), asc(schema.rrCycleAssignments.repId)],
  })

  return new Map<string, number>(served.map((row: any, index: number) => [row.repId, index]))
}
