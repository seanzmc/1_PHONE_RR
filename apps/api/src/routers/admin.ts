import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'

const ADVISORY_LOCK_KEY = 42_100_1

const setPolicyInputSchema = z.object({
  minCalls: z.number().int().min(0).optional(),
  enforcementMode: z.enum(['SHADOW', 'ENFORCE']).optional(),
})

export const adminRouter = router({
  /** The work-requirement policy: min calls/day and the SHADOW/ENFORCE switch. */
  policy: publicProcedure.use(requirePerm('schedule.manage')).query(async () => {
    const policy = await db.query.workRequirementPolicy.findFirst()
    if (!policy) return null
    return {
      id: policy.id,
      minCalls: policy.minCalls,
      enforcementMode: policy.enforcementMode,
      maxPriorWorkdayAge: policy.maxPriorWorkdayAge,
    }
  }),

  /**
   * ADMIN-only. Disqualification ships in SHADOW and only an ADMIN flips it to ENFORCE
   * after the 1–2 week calibration window (CLAUDE.md).
   */
  setPolicy: publicProcedure
    .use(requirePerm('admin.*'))
    .input(setPolicyInputSchema)
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`)

        const policy = await tx.query.workRequirementPolicy.findFirst()
        if (!policy) throw new Error('no work_requirement_policy row configured')
        const next = {
          minCalls: input.minCalls ?? policy.minCalls,
          enforcementMode: input.enforcementMode ?? policy.enforcementMode,
        }
        await tx
          .update(schema.workRequirementPolicy)
          .set(next)
          .where(eq(schema.workRequirementPolicy.id, policy.id))
        await tx.insert(schema.auditEvents).values({
          actorUserId: ctx.session.userId,
          action: 'policy.set',
          entityType: 'work_requirement_policy',
          entityId: policy.id,
          before: { minCalls: policy.minCalls, enforcementMode: policy.enforcementMode },
          after: next,
        })
        return next
      })
    }),
})
