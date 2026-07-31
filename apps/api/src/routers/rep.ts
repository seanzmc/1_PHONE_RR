import { z } from 'zod'
import { db, schema } from '@phoneup/db'
import { statusOverrideInputSchema, bulkStatusOverrideInputSchema, setDaysOffInputSchema } from '@phoneup/contracts'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { overrideStatus } from '../domain/overrideStatus'
import { bulkOverrideStatus } from '../domain/bulkOverrideStatus'
import {
  getRecurringDaysOffForReps,
  setRecurringDaysOff,
} from '../domain/daysOff'
import { materializeShifts } from '../jobs/eligibility'

export const repRouter = router({
  overrideStatus: publicProcedure
    .use(requirePerm('rep.override'))
    .input(statusOverrideInputSchema)
    .mutation(async ({ ctx, input }) => {
      await overrideStatus(db, { ...input, actorUserId: ctx.session.userId })
      return { ok: true }
    }),

  /** Same decision applied to many reps, in one transaction under one advisory lock. */
  bulkOverrideStatus: publicProcedure
    .use(requirePerm('rep.override'))
    .input(bulkStatusOverrideInputSchema)
    .mutation(async ({ ctx, input }) => {
      return bulkOverrideStatus(db, { ...input, actorUserId: ctx.session.userId })
    }),

  /**
   * The whole days-off column in one query. The Staff List used to issue one `daysOff`
   * call per rep on every board realtime event — every assign, void and status change —
   * which on a 30-rep roster is 30 requests per event.
   *
   * Every rep is present, with `[]` when they have none: the client must never have to
   * tell "no day off" apart from "not loaded yet".
   */
  allDaysOff: publicProcedure.use(requirePerm('schedule.manage')).query(async () => {
    const reps = await db.select({ id: schema.salesRep.id }).from(schema.salesRep)
    const byRep = await getRecurringDaysOffForReps(
      db,
      reps.map((r) => r.id),
    )
    return Object.fromEntries(reps.map((r) => [r.id, byRep.get(r.id) ?? []])) as Record<string, number[]>
  }),

  setDaysOff: publicProcedure
    .use(requirePerm('schedule.manage'))
    .input(setDaysOffInputSchema)
    .mutation(async ({ ctx, input }) => {
      return setRecurringDaysOff(db, { ...input, actorUserId: ctx.session.userId })
    }),

  /** Manual kick of the shift materializer, for setup and after a bulk roster import. */
  materializeShifts: publicProcedure
    .use(requirePerm('schedule.manage'))
    .input(z.object({ days: z.number().int().min(1).max(60).optional() }).optional())
    .mutation(async ({ input }) => {
      return materializeShifts(db, { days: input?.days ?? 14 })
    }),
})
