import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'

const inputSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
})

export const auditRouter = router({
  list: publicProcedure.use(requirePerm('audit.view')).input(inputSchema).query(async ({ input }) => {
    const rows = await db
      .select({ event: schema.auditEvents, actor: schema.appUser })
      .from(schema.auditEvents)
      .leftJoin(schema.appUser, eq(schema.auditEvents.actorUserId, schema.appUser.id))
      .orderBy(desc(schema.auditEvents.createdAt), desc(schema.auditEvents.id))
      .limit(input.limit + 1)
      .offset(input.offset)

    const hasMore = rows.length > input.limit
    return {
      items: rows.slice(0, input.limit).map(({ event, actor }) => ({
        id: event.id,
        createdAt: event.createdAt.toISOString(),
        actor: actor ? { displayName: actor.displayName, email: actor.email } : null,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: event.before,
        after: event.after,
      })),
      hasMore,
    }
  }),
})
