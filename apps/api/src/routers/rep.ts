import { z } from 'zod'
import { db } from '@phoneup/db'
import { statusOverrideInputSchema, setDaysOffInputSchema } from '@phoneup/contracts'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { overrideStatus } from '../domain/overrideStatus'
import { getRecurringDaysOff, getUpcomingShifts, setRecurringDaysOff } from '../domain/daysOff'
import { materializeShifts } from '../jobs/eligibility'

const repIdInputSchema = z.object({ repId: z.string().uuid() })

export const repRouter = router({
  overrideStatus: publicProcedure
    .use(requirePerm('rep.override'))
    .input(statusOverrideInputSchema)
    .mutation(async ({ ctx, input }) => {
      await overrideStatus(db, { ...input, actorUserId: ctx.session.userId })
      return { ok: true }
    }),

  /** Recurring weekly days off for a rep (design pass §I). */
  daysOff: publicProcedure
    .use(requirePerm('schedule.manage'))
    .input(repIdInputSchema)
    .query(async ({ input }) => {
      return {
        daysOfWeek: await getRecurringDaysOff(db, input.repId),
        upcoming: await getUpcomingShifts(db, input.repId),
      }
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
