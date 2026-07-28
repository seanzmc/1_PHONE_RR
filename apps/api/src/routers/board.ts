import { eq, isNull } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { rankReps, businessDate, periodKey, type RepRankInput } from '@phoneup/core'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'

function hashRepIdToSeed(repId: string): number {
  let h = 0
  for (const c of repId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}

async function computeRoster(): Promise<RepRankInput[]> {
  const bDate = businessDate(new Date())
  const pKey = periodKey(bDate)

  const reps = await db.select().from(schema.salesRep)
  const statuses = await db.query.repDailyStatus.findMany({ where: eq(schema.repDailyStatus.businessDate, bDate) })
  const counters = await db.query.repMonthCounters.findMany({ where: eq(schema.repMonthCounters.periodKey, pKey) })
  const cycle = await db.query.rotationCycle.findFirst({ where: isNull(schema.rotationCycle.closedAt) })
  const servedThisCycle = cycle
    ? await db.query.rrCycleAssignments.findMany({ where: eq(schema.rrCycleAssignments.cycleId, cycle.id) })
    : []

  const statusByRep = new Map(statuses.map((s: any) => [s.repId, s]))
  const counterByRep = new Map(counters.map((c: any) => [c.repId, c]))
  const servedSet = new Set(servedThisCycle.map((s: any) => s.repId))

  const rankInputs: RepRankInput[] = reps.map((rep: any) => {
    const status = statusByRep.get(rep.id)
    const counter = counterByRep.get(rep.id)
    return {
      repId: rep.id,
      isEligible: status?.status === 'ELIGIBLE',
      ineligibleReason: status?.reason ?? undefined,
      servedThisCycle: servedSet.has(rep.id),
      monthlyLoad: counter?.upsMtd ?? 0,
      lastAssignedAt: counter?.lastAssignedAt ? counter.lastAssignedAt.toISOString() : null,
      rotationSeed: hashRepIdToSeed(rep.id),
    }
  })

  return rankReps(rankInputs)
}

export const boardRouter = router({
  roster: publicProcedure.use(requirePerm('board.view')).query(async () => {
    const ranked = await computeRoster()
    const repRows = await db.select().from(schema.salesRep)
    const nameById = new Map(repRows.map((r: any) => [r.id, r.displayName]))
    return ranked.map((r) => ({ ...r, displayName: nameById.get(r.repId) ?? 'Unknown' }))
  }),

  dashboardSummary: publicProcedure.use(requirePerm('board.view')).query(async () => {
    const pKey = periodKey(businessDate(new Date()))
    const bDate = businessDate(new Date())

    const counters = await db.query.repMonthCounters.findMany({ where: eq(schema.repMonthCounters.periodKey, pKey) })
    const repRows = await db.select().from(schema.salesRep)
    const nameById = new Map(repRows.map((r: any) => [r.id, r.displayName]))
    const upsPerRep = counters.map((c: any) => ({ repName: nameById.get(c.repId) ?? 'Unknown', ups: c.upsMtd }))

    const cycle = await db.query.rotationCycle.findFirst({ where: isNull(schema.rotationCycle.closedAt) })
    const servedThisCycle = cycle
      ? await db.query.rrCycleAssignments.findMany({ where: eq(schema.rrCycleAssignments.cycleId, cycle.id) })
      : []
    const cycleProgress = { served: servedThisCycle.length, totalReps: repRows.length }

    const statuses = await db.query.repDailyStatus.findMany({ where: eq(schema.repDailyStatus.businessDate, bDate) })
    const disqualifiedCount = statuses.filter((s: any) => s.status === 'INELIGIBLE').length

    const overrides = await db.query.statusOverride.findMany({ where: eq(schema.statusOverride.businessDate, bDate) })

    return {
      upsPerRep,
      cycleProgress,
      disqualifiedCount,
      overrideCount: overrides.length,
    }
  }),
})
