import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { rankReps, businessDate, periodKey, type RepRankInput } from '@phoneup/core'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { selectActiveReps } from '../domain/activeReps'
import { loadPriorCycleOrder } from '../domain/priorCycleOrder'

function hashRepIdToSeed(repId: string): number {
  let h = 0
  for (const c of repId) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}

type TeamStatusRow = {
  repId: string
  businessDate: string
  status: string
  reason: string | null
}

/** One WEEK_DQ suspension spans several dates but counts as one deactivation episode. */
export function countDeactivationEpisodes(statuses: TeamStatusRow[]): number {
  const dqRows = statuses
    .filter((row) => row.status === 'INELIGIBLE' && (row.reason ?? '').startsWith('WEEK_DQ'))
    .sort((a, b) => a.repId.localeCompare(b.repId) || a.businessDate.localeCompare(b.businessDate))
  let count = 0
  let previousEpisode: string | null = null
  for (const row of dqRows) {
    const episode = `${row.repId}:${row.reason}`
    if (episode !== previousEpisode) count++
    previousEpisode = episode
  }
  return count
}

async function computeRoster(): Promise<{
  ranked: RepRankInput[]
  decidedByRep: Map<string, 'SYSTEM' | 'MANAGER_OVERRIDE'>
  servedAtByRep: Map<string, Date>
  skippedRepIds: Set<string>
}> {
  const bDate = businessDate(new Date())
  const pKey = periodKey(bDate)

  const reps = await selectActiveReps(db)
  const statuses = await db.query.repDailyStatus.findMany({ where: eq(schema.repDailyStatus.businessDate, bDate) })
  const counters = await db.query.repMonthCounters.findMany({ where: eq(schema.repMonthCounters.periodKey, pKey) })
  const cycle = await db.query.rotationCycle.findFirst({ where: isNull(schema.rotationCycle.closedAt) })
  const servedThisCycle = cycle
    ? await db.query.rrCycleAssignments.findMany({ where: eq(schema.rrCycleAssignments.cycleId, cycle.id) })
    : []
  const servedAtByRep = new Map(servedThisCycle.map((row: any) => [row.repId, row.assignedAt]))
  const skipEvents = cycle
    ? await db.query.assignmentEvents.findMany({
        where: and(
          eq(schema.assignmentEvents.cycleNo, cycle.id),
          eq(schema.assignmentEvents.eventType, 'SKIP'),
        ),
      })
    : []
  const skippedRepIds = new Set(skipEvents.flatMap((event: any) => event.repId ? [event.repId] : []))

  const statusByRep = new Map(statuses.map((s: any) => [s.repId, s]))
  const counterByRep = new Map(counters.map((c: any) => [c.repId, c]))
  const servedSet = new Set(servedThisCycle.map((s: any) => s.repId))
  // Same input assignLead ranks on, or the board names a rep the next lead will not go to.
  const priorCycleOrderByRep = await loadPriorCycleOrder(db)

  const rankInputs: RepRankInput[] = reps.map((rep: any) => {
    const status = statusByRep.get(rep.id)
    const counter = counterByRep.get(rep.id)
    return {
      repId: rep.id,
      isEligible: status?.status === 'ELIGIBLE',
      ineligibleReason: status?.reason ?? undefined,
      servedThisCycle: servedSet.has(rep.id),
      priorCycleOrder: priorCycleOrderByRep.get(rep.id),
      monthlyLoad: counter?.upsMtd ?? 0,
      lastAssignedAt: counter?.lastAssignedAt ? counter.lastAssignedAt.toISOString() : null,
      rotationSeed: hashRepIdToSeed(rep.id),
    }
  })

  // Presentation only, so it is merged at the response layer rather than pushed into
  // RepRankInput — the ranking algorithm has no business reading who decided a status.
  const decidedByRep = new Map<string, 'SYSTEM' | 'MANAGER_OVERRIDE'>(
    statuses.map((s: any) => [s.repId, s.decidedBy]),
  )

  return { ranked: rankReps(rankInputs), decidedByRep, servedAtByRep, skippedRepIds }
}

export const boardRouter = router({
  roster: publicProcedure.use(requirePerm('board.view')).query(async () => {
    const { ranked, decidedByRep, servedAtByRep, skippedRepIds } = await computeRoster()
    const repRows = await selectActiveReps(db)
    const nameById = new Map(repRows.map((r: any) => [r.id, r.displayName]))
    return ranked.map((r) => ({
      ...r,
      displayName: nameById.get(r.repId) ?? 'Unknown',
      // null when the rep has no rep_daily_status row for today.
      decidedBy: decidedByRep.get(r.repId) ?? null,
      servedAt: servedAtByRep.get(r.repId)?.toISOString() ?? null,
      skippedThisCycle: skippedRepIds.has(r.repId),
    }))
  }),

  dashboardSummary: publicProcedure.use(requirePerm('board.view')).query(async () => {
    const pKey = periodKey(businessDate(new Date()))
    const bDate = businessDate(new Date())

    const counters = await db.query.repMonthCounters.findMany({ where: eq(schema.repMonthCounters.periodKey, pKey) })
    const repRows = await selectActiveReps(db)
    const activeRepIds = new Set(repRows.map((rep: any) => rep.id))
    const activeRepIdList = [...activeRepIds]
    const nameById = new Map(repRows.map((r: any) => [r.id, r.displayName]))
    const upsPerRep = counters.filter((c: any) => activeRepIds.has(c.repId)).map((c: any) => ({
      repId: c.repId,
      repName: nameById.get(c.repId) ?? 'Unknown',
      ups: c.upsMtd,
    }))

    const cycle = await db.query.rotationCycle.findFirst({ where: isNull(schema.rotationCycle.closedAt) })
    const servedThisCycle = cycle
      ? await db.query.rrCycleAssignments.findMany({ where: eq(schema.rrCycleAssignments.cycleId, cycle.id) })
      : []
    const cycleProgress = {
      served: servedThisCycle.filter((row: any) => activeRepIds.has(row.repId)).length,
      totalReps: repRows.length,
    }

    const statuses = await db.query.repDailyStatus.findMany({ where: eq(schema.repDailyStatus.businessDate, bDate) })
    const disqualifiedCount = statuses.filter(
      (s: any) => activeRepIds.has(s.repId) && s.status === 'INELIGIBLE',
    ).length

    const overrides = await db.query.statusOverride.findMany({ where: eq(schema.statusOverride.businessDate, bDate) })

    const periodStart = `${pKey}-01`
    const [year, month] = pKey.split('-').map(Number)
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const periodEnd = `${pKey}-${String(lastDay).padStart(2, '0')}`

    const activityRows = activeRepIdList.length
      ? await db
          .select({ sold: schema.repDailyActivity.sold })
          .from(schema.repDailyActivity)
          .where(
            and(
              inArray(schema.repDailyActivity.repId, activeRepIdList),
              gte(schema.repDailyActivity.businessDate, periodStart),
              lte(schema.repDailyActivity.businessDate, periodEnd),
            ),
          )
      : []
    const reassignments = activeRepIdList.length
      ? await db
          .select({ id: schema.assignmentEvents.id })
          .from(schema.assignmentEvents)
          .where(
            and(
              inArray(schema.assignmentEvents.repId, activeRepIdList),
              eq(schema.assignmentEvents.eventType, 'REASSIGN_IN'),
              sql`to_char(${schema.assignmentEvents.createdAt} at time zone 'America/New_York', 'YYYY-MM') = ${pKey}`,
            ),
          )
      : []
    const monthStatuses = activeRepIdList.length
      ? await db
          .select({
            repId: schema.repDailyStatus.repId,
            businessDate: schema.repDailyStatus.businessDate,
            status: schema.repDailyStatus.status,
            reason: schema.repDailyStatus.reason,
          })
          .from(schema.repDailyStatus)
          .where(
            and(
              inArray(schema.repDailyStatus.repId, activeRepIdList),
              gte(schema.repDailyStatus.businessDate, periodStart),
              lte(schema.repDailyStatus.businessDate, periodEnd),
            ),
          )
      : []
    const deactivationsMtd = countDeactivationEpisodes(monthStatuses)

    return {
      periodKey: pKey,
      totals: {
        assignmentsMtd: upsPerRep.reduce((sum, rep) => sum + rep.ups, 0),
        reassignmentsMtd: reassignments.length,
        deactivationsMtd,
        salesMtd: activityRows.reduce((sum, row) => sum + row.sold, 0),
      },
      upsPerRep,
      cycleProgress,
      disqualifiedCount,
      overrideCount: overrides.filter((row: any) => activeRepIds.has(row.repId)).length,
    }
  }),
})
