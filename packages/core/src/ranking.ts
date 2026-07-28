export type RepRankInput = {
  repId: string
  isEligible: boolean
  ineligibleReason?: string
  servedThisCycle: boolean
  monthlyLoad: number
  lastAssignedAt: string | null
  rotationSeed: number
}

export function rankReps(reps: RepRankInput[]): RepRankInput[] {
  return [...reps].sort((x, y) => {
    if (x.isEligible !== y.isEligible) return x.isEligible ? -1 : 1
    if (x.servedThisCycle !== y.servedThisCycle) return x.servedThisCycle ? 1 : -1
    if (x.monthlyLoad !== y.monthlyLoad) return x.monthlyLoad - y.monthlyLoad
    const xLast = x.lastAssignedAt ?? ''
    const yLast = y.lastAssignedAt ?? ''
    if (xLast !== yLast) return xLast < yLast ? -1 : 1
    if (x.rotationSeed !== y.rotationSeed) return x.rotationSeed - y.rotationSeed
    return x.repId < y.repId ? -1 : x.repId > y.repId ? 1 : 0
  })
}
