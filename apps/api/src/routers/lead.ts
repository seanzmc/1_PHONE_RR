import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq, and, desc } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { setLeadNoteInputSchema, hasPermission } from '@phoneup/contracts'
import { businessDate, periodKey } from '@phoneup/core'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'

const byRepInputSchema = z.object({
  repId: z.string().uuid().optional(),
  periodKey: z.string().regex(/^\d{4}-\d{2}$/).optional(),
})

/** The sales_rep row belonging to the logged-in user, if they are a rep. */
async function ownRepId(userId: string): Promise<string | null> {
  const rep = await db.query.salesRep.findFirst({ where: eq(schema.salesRep.userId, userId) })
  return rep?.id ?? null
}

export const leadRouter = router({
  /**
   * A rep's leads for a period (design pass §D and §K — one query behind both screens).
   * A REP may only read their own; MANAGER/ADMIN may read any rep's.
   */
  byRep: publicProcedure
    .use(requirePerm('board.view'))
    .input(byRepInputSchema)
    .query(async ({ ctx, input }) => {
      const canViewOthers = hasPermission(ctx.session.role, 'rep.view')
      const selfRepId = await ownRepId(ctx.session.userId)
      const repId = input.repId ?? selfRepId

      if (!repId) throw new TRPCError({ code: 'NOT_FOUND', message: 'no sales_rep record for this user' })
      if (!canViewOthers && repId !== selfRepId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'you can only view your own leads' })
      }

      const pKey = input.periodKey ?? periodKey(businessDate(new Date()))

      const rows = await db
        .select({
          id: schema.lead.id,
          businessDate: schema.lead.businessDate,
          status: schema.lead.status,
          managerNote: schema.lead.managerNote,
          createdAt: schema.lead.createdAt,
          createdBy: schema.lead.createdBy,
          customerName: schema.customer.fullName,
          customerPhoneE164: schema.customer.phoneE164,
        })
        .from(schema.lead)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.lead.customerId))
        .where(and(eq(schema.lead.assignedRepId, repId), eq(schema.lead.periodKey, pKey)))
        .orderBy(desc(schema.lead.createdAt))

      // resolve "assigned by" once, not per row
      const creatorIds = Array.from(new Set(rows.map((r: any) => r.createdBy)))
      const creators = await db.select().from(schema.appUser)
      const creatorById = new Map(
        creators
          .filter((u: any) => creatorIds.includes(u.id))
          .map((u: any) => [u.id, u.displayName ?? u.email]),
      )

      return rows.map((r: any) => ({
        id: r.id,
        businessDate: r.businessDate,
        status: r.status,
        note: r.managerNote,
        customerName: r.customerName,
        customerPhoneE164: r.customerPhoneE164,
        assignedBy: creatorById.get(r.createdBy) ?? 'Unknown',
        createdAt: r.createdAt.toISOString(),
      }))
    }),

  /**
   * Write a lead's follow-up note. MANAGER/ADMIN on any lead, BDC on their own only.
   * Reps have no write route — they read notes on their dashboard (§K).
   */
  setNote: publicProcedure
    .use(requirePerm('lead.note'))
    .input(setLeadNoteInputSchema)
    .mutation(async ({ ctx, input }) => {
      const lead = await db.query.lead.findFirst({ where: eq(schema.lead.id, input.leadId) })
      if (!lead) throw new TRPCError({ code: 'NOT_FOUND' })

      const canEditAny = hasPermission(ctx.session.role, 'rep.view') // MANAGER/ADMIN
      if (!canEditAny && lead.createdBy !== ctx.session.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'you can only note leads you created' })
      }

      const note = input.note.trim() === '' ? null : input.note

      await db.transaction(async (tx) => {
        await tx.update(schema.lead).set({ managerNote: note }).where(eq(schema.lead.id, lead.id))
        await tx.insert(schema.auditEvents).values({
          actorUserId: ctx.session.userId,
          action: 'lead.note.set',
          entityType: 'lead',
          entityId: lead.id,
          before: { note: lead.managerNote },
          after: { note },
        })
      })

      return { ok: true }
    }),
})
