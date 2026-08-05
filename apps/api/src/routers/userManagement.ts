import { z } from 'zod'
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
import { generateTempPassword } from '@phoneup/core'

export const userManagementRouter = router({
  /**
   * The protected owner account is filtered out for everyone else — it is invisible in the
   * Users page by design. A protected caller gets the unfiltered list so it can see itself,
   * and so a second protected account would not be invisible to the first.
   */
  list: publicProcedure.use(requirePerm('user.manage')).query(async ({ ctx }) => {
    // One query, filtered in memory. Do NOT look the caller up with
    // `eq(schema.appUser.id, ctx.session.userId)` — existing tests in this file build
    // sessions with non-UUID ids like 'u1', and Postgres rejects those with
    // "invalid input syntax for type uuid" before any filtering happens.
    const all = await db.select().from(schema.appUser)
    const caller = all.find((u: any) => u.id === ctx.session.userId)
    const rows = caller?.isProtected ? all : all.filter((u: any) => !u.isProtected)

    return rows.map((u: any) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      isActive: u.isActive,
      mustChangePassword: u.mustChangePassword,
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
      if (!hasPermission(ctx.session.role, 'admin.*')) {
        const target = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
        if (target?.role === 'ADMIN') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'only an ADMIN can activate or deactivate an ADMIN account',
          })
        }
      }

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

  /**
   * The easy path: generate a short speakable temp password, force a change on next
   * login, and hand it back once so the manager can read it to the user. Not stored
   * anywhere in plaintext — if it's lost, generate another.
   */
  issueTempPassword: publicProcedure
    .use(requirePerm('user.manage'))
    .input(z.object({ userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      if (!hasPermission(ctx.session.role, 'admin.*')) {
        const target = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, input.userId) })
        if (target?.role === 'ADMIN') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'only an ADMIN can reset an ADMIN password' })
        }
      }

      const tempPassword = generateTempPassword()
      await resetPassword(db, {
        userId: input.userId,
        newPassword: tempPassword,
        actorUserId: ctx.session.userId,
        mustChangePassword: true,
      })

      // returned once, for the admin to relay; never persisted in the clear
      return { tempPassword }
    }),
})
