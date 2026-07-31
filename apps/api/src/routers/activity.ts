import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq, and, gte, lte, sql } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import {
  activityImportPreviewInputSchema,
  activityImportCommitInputSchema,
  setMetricInputSchema,
  hasPermission,
} from '@phoneup/contracts'
import { businessDate, periodKey } from '@phoneup/core'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { setActivityMetric } from '../jobs/activityImport'
import { previewDailyActivity, commitDailyActivity } from '../jobs/activityImportDecision'

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
  /**
   * ADMIN/MANAGER-only, side-effect-free review of a CRM report.
   * Nothing is saved here — this is why "Cancel entirely" is truthful.
   */
  preview: publicProcedure
    .use(requirePerm('activity.import'))
    .input(activityImportPreviewInputSchema)
    .mutation(async ({ input }) => {
      return previewDailyActivity(db, input.csv, input.businessDate, {
        statusDate: businessDate(new Date()),
      })
    }),

  /**
   * Commit the exact preview as either metrics-only or metrics + weekly DQ status writes.
   * The preview token is recomputed in the transaction, so a stale Yes can never apply
   * after a manual correction, policy change, or manager override.
   */
  commit: publicProcedure
    .use(requirePerm('activity.import'))
    .input(activityImportCommitInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.statusDate !== businessDate(new Date())) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'eligibility preview expired at the end of the business day; process the report again',
        })
      }
      try {
        return await commitDailyActivity(db, { ...input, actorUserId: ctx.session.userId })
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message.startsWith('PREVIEW_STALE') ||
            error.message.startsWith('PREVIEW_ALREADY_COMMITTED'))
        ) {
          throw new TRPCError({ code: 'CONFLICT', message: error.message })
        }
        throw error
      }
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

      // Today's rotation status + recurring day off — the answer to the one question a
      // rep has ("am I in today, and if not, why"). Read-only, like every other query here.
      const today = businessDate(new Date())
      const todayRows = await db
        .select()
        .from(schema.repDailyStatus)
        .where(and(eq(schema.repDailyStatus.repId, repId), eq(schema.repDailyStatus.businessDate, today)))
        .limit(1)
      const dayOffRows = await db
        .select({ dayOfWeek: schema.repRecurringDayOff.dayOfWeek })
        .from(schema.repRecurringDayOff)
        .where(eq(schema.repRecurringDayOff.repId, repId))

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
        today: {
          businessDate: today,
          isEligible: todayRows[0]?.status === 'ELIGIBLE',
          reason: todayRows[0]?.reason ?? null,
        },
        daysOff: dayOffRows.map((r) => r.dayOfWeek).sort(),
      }
    }),
})
