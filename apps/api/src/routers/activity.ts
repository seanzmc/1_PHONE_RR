import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq, and, gte, lte, sql } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { activityImportInputSchema, setMetricInputSchema, hasPermission } from '@phoneup/contracts'
import { businessDate, periodKey } from '@phoneup/core'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { importDailyActivity, setActivityMetric } from '../jobs/activityImport'

const byRepInputSchema = z.object({
  repId: z.string().uuid().optional(),
  periodKey: z.string().regex(/^\d{4}-\d{2}$/).optional(),
})

async function ownRepId(userId: string): Promise<string | null> {
  const rep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, userId) })
  return rep?.id ?? null
}

/** First and last calendar date of a YYYY-MM period key. */
function periodBounds(pKey: string): { start: string; end: string } {
  const [year, month] = pKey.split('-').map(Number)
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { start: `${pKey}-01`, end: `${pKey}-${String(last).padStart(2, '0')}` }
}

export const activityRouter = router({
  /** ADMIN/MANAGER-only upload of the CRM daily activity export (design pass §H). */
  import: publicProcedure
    .use(requirePerm('activity.import'))
    .input(activityImportInputSchema)
    .mutation(async ({ ctx, input }) => {
      return importDailyActivity(db, input.csv, input.businessDate, { actorUserId: ctx.session.userId })
    }),

  /** Manager/admin correction of an imported metric (design pass §J). */
  setMetric: publicProcedure
    .use(requirePerm('activity.edit'))
    .input(setMetricInputSchema)
    .mutation(async ({ ctx, input }) => {
      await setActivityMetric(db, { ...input, actorUserId: ctx.session.userId })
      return { ok: true }
    }),

  /** Per-day activity rows for a rep in a period — powers the drill-down inline edit. */
  byRep: publicProcedure
    .use(requirePerm('board.view'))
    .input(byRepInputSchema)
    .query(async ({ ctx, input }) => {
      const canViewOthers = hasPermission(ctx.session.role, 'rep.view')
      const selfRepId = await ownRepId(ctx.session.userId)
      const repId = input.repId ?? selfRepId
      if (!repId) throw new TRPCError({ code: 'NOT_FOUND', message: 'no sales_rep record for this user' })
      if (!canViewOthers && repId !== selfRepId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'you can only view your own activity' })
      }

      const pKey = input.periodKey ?? periodKey(businessDate(new Date()))
      const { start, end } = periodBounds(pKey)

      const rows = await db
        .select()
        .from(schema.repDailyActivity)
        .where(
          and(
            eq(schema.repDailyActivity.repId, repId),
            gte(schema.repDailyActivity.businessDate, start),
            lte(schema.repDailyActivity.businessDate, end),
          ),
        )

      return rows
        .map((r: any) => ({
          businessDate: r.businessDate,
          calls: r.calls,
          sold: r.sold,
          source: r.source,
        }))
        .sort((a, b) => (a.businessDate < b.businessDate ? 1 : -1))
    }),

  /**
   * Rep dashboard counters, all scoped to the current calendar period (design pass §K).
   * Read-only: reps have no route that writes status or activity.
   */
  repSummary: publicProcedure
    .use(requirePerm('board.view'))
    .input(byRepInputSchema)
    .query(async ({ ctx, input }) => {
      const canViewOthers = hasPermission(ctx.session.role, 'rep.view')
      const selfRepId = await ownRepId(ctx.session.userId)
      const repId = input.repId ?? selfRepId
      if (!repId) throw new TRPCError({ code: 'NOT_FOUND', message: 'no sales_rep record for this user' })
      if (!canViewOthers && repId !== selfRepId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'you can only view your own summary' })
      }

      const pKey = input.periodKey ?? periodKey(businessDate(new Date()))
      const { start, end } = periodBounds(pKey)

      const rep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.id, repId) })

      // total ups this month — the ledger-backed projection, void-correct after §A
      const counter = await db.query.repMonthCounters.findFirst({
        where: and(eq(schema.repMonthCounters.repId, repId), eq(schema.repMonthCounters.periodKey, pKey)),
      })

      // calls + sales this month — SUM over per-day rows. The unique (rep_id, business_date)
      // key plus upsert-on-import is what keeps this sum honest across re-imports (§H).
      const totals = await db
        .select({
          calls: sql<number>`coalesce(sum(${schema.repDailyActivity.calls}), 0)::int`,
          sold: sql<number>`coalesce(sum(${schema.repDailyActivity.sold}), 0)::int`,
        })
        .from(schema.repDailyActivity)
        .where(
          and(
            eq(schema.repDailyActivity.repId, repId),
            gte(schema.repDailyActivity.businessDate, start),
            lte(schema.repDailyActivity.businessDate, end),
          ),
        )

      // Status rows for the period, so "days inactive" and "times deactivated" can be
      // computed with scheduled days off excluded.
      const statuses = await db
        .select()
        .from(schema.repDailyStatus)
        .where(
          and(
            eq(schema.repDailyStatus.repId, repId),
            gte(schema.repDailyStatus.businessDate, start),
            lte(schema.repDailyStatus.businessDate, end),
          ),
        )
      const shifts = await db
        .select()
        .from(schema.repShift)
        .where(
          and(
            eq(schema.repShift.repId, repId),
            gte(schema.repShift.businessDate, start),
            lte(schema.repShift.businessDate, end),
          ),
        )
      const scheduledOff = new Set(
        shifts.filter((s: any) => s.kind !== 'WORK').map((s: any) => s.businessDate),
      )

      // Days inactive — INELIGIBLE dates, EXCLUDING scheduled days off. Without that
      // exclusion every part-week rep looks delinquent.
      const inactiveDates = statuses
        .filter((s: any) => s.status === 'INELIGIBLE' && !scheduledOff.has(s.businessDate))
        .map((s: any) => s.businessDate)
        .sort()

      // Times deactivated — distinct DQ *episodes*, not ineligible days: one WEEK_DQ
      // suspension counts once however many days it spans. Consecutive DQ dates sharing the
      // same reason are one episode.
      const dqRows = statuses
        .filter((s: any) => s.status === 'INELIGIBLE' && (s.reason ?? '').startsWith('WEEK_DQ'))
        .sort((a: any, b: any) => (a.businessDate < b.businessDate ? -1 : 1))
      let timesDeactivated = 0
      let lastReason: string | null = null
      for (const row of dqRows) {
        if (row.reason !== lastReason) {
          timesDeactivated++
          lastReason = row.reason
        }
      }

      return {
        repId,
        displayName: rep?.displayName ?? 'Unknown',
        periodKey: pKey,
        upsMtd: counter?.upsMtd ?? 0,
        callsMtd: totals[0]?.calls ?? 0,
        soldMtd: totals[0]?.sold ?? 0,
        timesDeactivated,
        daysInactive: inactiveDates.length,
        inactiveDates,
      }
    }),
})
