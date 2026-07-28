import { TRPCError } from '@trpc/server'
import { eq, and, sql } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { assignLeadInputSchema, voidLeadInputSchema, hasPermission } from '@phoneup/contracts'
import { businessDate } from '@phoneup/core'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { assignLead } from '../domain/assignLead'

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

      await db.transaction(async (tx) => {
        await tx.update(schema.lead).set({ status: 'VOID' }).where(eq(schema.lead.id, input.leadId))
        await tx.insert(schema.assignmentEvents).values({
          leadId: lead.id,
          repId: lead.assignedRepId,
          eventType: 'VOID',
          cycleNo: (await tx.query.assignmentEvents.findFirst({ where: eq(schema.assignmentEvents.leadId, lead.id) }))!
            .cycleNo,
          creditDelta: -1,
          queueSnapshot: [],
          idempotencyKey: `void-${input.leadId}-${Date.now()}`,
        })
        if (lead.assignedRepId) {
          await tx
            .update(schema.repMonthCounters)
            .set({ upsMtd: sql`${schema.repMonthCounters.upsMtd} - 1` })
            .where(
              and(
                eq(schema.repMonthCounters.repId, lead.assignedRepId),
                eq(schema.repMonthCounters.periodKey, lead.periodKey),
              ),
            )
        }
      })

      return { ok: true }
    }),
})
