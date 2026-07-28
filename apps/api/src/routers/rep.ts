import { db } from '@phoneup/db'
import { statusOverrideInputSchema } from '@phoneup/contracts'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { overrideStatus } from '../domain/overrideStatus'

export const repRouter = router({
  overrideStatus: publicProcedure
    .use(requirePerm('rep.override'))
    .input(statusOverrideInputSchema)
    .mutation(async ({ ctx, input }) => {
      await overrideStatus(db, { ...input, actorUserId: ctx.session.userId })
      return { ok: true }
    }),
})
