export type RepRankInput = {
  repId: string
  isEligible: boolean
  ineligibleReason?: string
  servedThisCycle: boolean
  /**
   * Position in the immediately preceding completed cycle.  When a new
   * cycle opens, preserve the order reps entered Served This Round instead
   * of letting their already-different monthly totals reshuffle them.
   */
  priorCycleOrder?: number
  monthlyLoad: number
  lastAssignedAt: string | null
  rotationSeed: number
}

export function rankReps(reps: RepRankInput[]): RepRankInput[] {
  return [...reps].sort((x, y) => {
    if (x.isEligible !== y.isEligible) return x.isEligible ? -1 : 1
    if (x.servedThisCycle !== y.servedThisCycle) return x.servedThisCycle ? 1 : -1
    const xPriorCycleOrder = x.priorCycleOrder ?? Number.MAX_SAFE_INTEGER
    const yPriorCycleOrder = y.priorCycleOrder ?? Number.MAX_SAFE_INTEGER
    if (xPriorCycleOrder !== yPriorCycleOrder) return xPriorCycleOrder - yPriorCycleOrder
    if (x.monthlyLoad !== y.monthlyLoad) return x.monthlyLoad - y.monthlyLoad
    const xLast = x.lastAssignedAt ?? ''
    const yLast = y.lastAssignedAt ?? ''
    if (xLast !== yLast) return xLast < yLast ? -1 : 1
    if (x.rotationSeed !== y.rotationSeed) return x.rotationSeed - y.rotationSeed
    return x.repId < y.repId ? -1 : x.repId > y.repId ? 1 : 0
  })
}
