export type RepRankInput = {
  repId: string
  isEligible: boolean
  ineligibleReason?: string
  servedThisCycle: boolean
  /**
   * Position in the immediately preceding completed cycle, or undefined for a rep who
   * held no position in it. When a new cycle opens, preserve the order reps entered
   * Served This Round instead of letting their already-different monthly totals
   * reshuffle them.
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
    // No position in the preceding cycle => ahead of everyone who had one. That rep was
    // out sick, reactivated mid-cycle, newly hired, or had their assignment voided: they
    // never took a turn, so they take the next one. Sinking them instead would be
    // permanent — the following cycle would record them last again, and monthly load can
    // no longer pull them back once prior-cycle order outranks it.
    const xPriorCycleOrder = x.priorCycleOrder ?? -1
    const yPriorCycleOrder = y.priorCycleOrder ?? -1
    if (xPriorCycleOrder !== yPriorCycleOrder) return xPriorCycleOrder - yPriorCycleOrder
    if (x.monthlyLoad !== y.monthlyLoad) return x.monthlyLoad - y.monthlyLoad
    const xLast = x.lastAssignedAt ?? ''
    const yLast = y.lastAssignedAt ?? ''
    if (xLast !== yLast) return xLast < yLast ? -1 : 1
    if (x.rotationSeed !== y.rotationSeed) return x.rotationSeed - y.rotationSeed
    return x.repId < y.repId ? -1 : x.repId > y.repId ? 1 : 0
  })
}
