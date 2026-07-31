import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { assignLeadInputSchema, voidLeadInputSchema, reassignLeadInputSchema, hasPermission } from '@phoneup/contracts'
import { businessDate } from '@phoneup/core'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { assignLead } from '../domain/assignLead'
import { voidLead } from '../domain/voidLead'
import { reassignLead } from '../domain/reassignLead'

export const assignmentRouter = router({
  assign: publicProcedure
    .use(requirePerm('lead.assign'))
    .input(assignLeadInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (input.forcedRepId && !hasPermission(ctx.session.role, 'lead.assign.override')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'forcedRepId requires lead.assign.override' })
      }
      return assignLead(db, { ...input, actorUserId: ctx.session.userId })
    }),

  reassign: publicProcedure
    .use(requirePerm('lead.assign.override'))
    .input(reassignLeadInputSchema)
    .mutation(async ({ ctx, input }) => {
      return reassignLead(db, { ...input, actorUserId: ctx.session.userId })
    }),

  void: publicProcedure
    .use(requirePerm('lead.void'))
    .input(voidLeadInputSchema)
    .mutation(async ({ ctx, input }) => {
      const lead = await db.query.lead.findFirst({ where: eq(schema.lead.id, input.leadId) })
      if (!lead) throw new TRPCError({ code: 'NOT_FOUND' })

      const isOwnAssignment = lead.createdBy === ctx.session.userId
      const canOverride = hasPermission(ctx.session.role, 'lead.assign.override')
      if (!isOwnAssignment && !canOverride) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'can only void your own leads' })
      }

      const today = businessDate(new Date())
      if (lead.businessDate !== today && !canOverride) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'void window has closed for this business day' })
      }

      await voidLead(db, { ...input, actorUserId: ctx.session.userId })
      return { ok: true }
    }),
})
