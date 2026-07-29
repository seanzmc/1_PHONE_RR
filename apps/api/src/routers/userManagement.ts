import { eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { db, schema } from '@phoneup/db'
import {
  createAccountInputSchema,
  setRoleInputSchema,
  setActiveInputSchema,
  resetPasswordInputSchema,
  hasPermission,
} from '@phoneup/contracts'
import { publicProcedure, router } from '../trpc/router'
import { requirePerm } from '../trpc/requirePerm'
import { createAccount, setRole, setActive, resetPassword } from '../domain/userManagement'

export const userManagementRouter = router({
  list: publicProcedure.use(requirePerm('user.manage')).query(async () => {
    const rows = await db.select().from(schema.appUser)
    return rows.map((u: any) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      isActive: u.isActive,
      createdAt: u.createdAt.toISOString(),
    }))
  }),

  create: publicProcedure
    .use(requirePerm('user.manage'))
    .input(createAccountInputSchema)
    .mutation(async ({ ctx, input }) => {
      return createAccount(db, { ...input, actorUserId: ctx.session.userId })
    }),

  setRole: publicProcedure
    .use(requirePerm('user.manage'))
    .input(setRoleInputSchema)
    .mutation(async ({ ctx, input }) => {
      const isAdminCaller = hasPermission(ctx.session.role, 'admin.*')

      if (input.newRole === 'ADMIN' && !isAdminCaller) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'only an ADMIN can grant the ADMIN role' })
      }

      if (!isAdminCaller) {
        const target = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
        if (target?.role === 'ADMIN') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'only an ADMIN can grant the ADMIN role' })
        }
      }

      await setRole(db, { ...input, actorUserId: ctx.session.userId })
      return { ok: true }
    }),

  setActive: publicProcedure
    .use(requirePerm('user.manage'))
    .input(setActiveInputSchema)
    .mutation(async ({ ctx, input }) => {
      await setActive(db, { ...input, actorUserId: ctx.session.userId })
      return { ok: true }
    }),

  resetPassword: publicProcedure
    .use(requirePerm('user.manage'))
    .input(resetPasswordInputSchema)
    .mutation(async ({ ctx, input }) => {
      if (!hasPermission(ctx.session.role, 'admin.*')) {
        const target = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
        if (target?.role === 'ADMIN') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'only an ADMIN can grant the ADMIN role' })
        }
      }

      await resetPassword(db, { ...input, actorUserId: ctx.session.userId })
      return { ok: true }
    }),
})
