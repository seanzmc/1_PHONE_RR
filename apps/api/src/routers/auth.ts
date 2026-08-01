import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { verifyPassword } from '../auth/password'
import { createSession, destroySession } from '../auth/session'
import { isThrottled, recordFailure, recordSuccess } from '../auth/loginThrottle'
import { publicProcedure, router } from '../trpc/router'
import { requireAuth, requirePerm } from '../trpc/requirePerm'
import { changeOwnPassword } from '../domain/userManagement'
import {
  completePasswordReset,
  requestPasswordReset,
  RESET_LINK_INVALID_OR_EXPIRED,
} from '../domain/passwordRecovery'
import { createResendPasswordResetSender } from '../email/resend'
import {
  checkRecoveryThrottle,
  recordRecoveryRequest,
} from '../auth/recoveryThrottle'

const loginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8),
})

const requestPasswordResetInputSchema = z.object({
  email: z.string().trim().email(),
})

const completePasswordResetInputSchema = z.object({
  token: z.string().min(16),
  newPassword: z.string().min(8),
})

export const authRouter = router({
  requestPasswordReset: publicProcedure
    .input(requestPasswordResetInputSchema)
    .mutation(async ({ ctx, input }) => {
      const email = input.email.toLowerCase()
      const ip = (ctx.req as any).ip ?? 'unknown'
      const keys = [`recovery-email:${email}`, `recovery-ip:${ip}`]
      const { throttled, retryAfter } = checkRecoveryThrottle(keys)
      if (throttled) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many password reset requests — try again in ${Math.ceil(retryAfter / 60)} minute(s)`,
        })
      }
      recordRecoveryRequest(keys)

      const apiKey = process.env.RESEND_API_KEY ?? ''
      const from = process.env.RESEND_FROM_EMAIL ?? ''
      const configuredAppBaseUrl = process.env.APP_BASE_URL ?? ''
      if (!apiKey || !from || !configuredAppBaseUrl) {
        ;(ctx.req as any).log?.error('password reset email delivery failed: email is not configured')
        return { ok: true }
      }
      let appBaseUrl: string
      try {
        const url = new URL(configuredAppBaseUrl)
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
        appBaseUrl = url.origin
      } catch {
        ;(ctx.req as any).log?.error('password reset email delivery failed: APP_BASE_URL is invalid')
        return { ok: true }
      }

      await requestPasswordReset(
        db,
        { email },
        {
          sendEmail: createResendPasswordResetSender({ apiKey, from }),
          appBaseUrl,
          logDeliveryFailure: (error) => {
            const message = error instanceof Error ? error.message : 'Password reset email delivery failed'
            ;(ctx.req as any).log?.error(`password reset email delivery failed: ${message}`)
          },
        },
      )
      return { ok: true }
    }),

  completePasswordReset: publicProcedure
    .input(completePasswordResetInputSchema)
    .mutation(async ({ input }) => {
      try {
        await completePasswordReset(db, input)
      } catch (error) {
        if (error instanceof Error && error.message === RESET_LINK_INVALID_OR_EXPIRED) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: RESET_LINK_INVALID_OR_EXPIRED })
        }
        throw error
      }
      return { ok: true }
    }),

  login: publicProcedure.input(loginInputSchema).mutation(async ({ ctx, input }) => {
    // Throttle before touching the DB: temporary passwords are short by design, so
    // rate limiting is what keeps the small keyspace from being swept.
    const email = input.email.toLowerCase()
    const ip = (ctx.req as any).ip ?? 'unknown'
    const keys = [`email:${email}`, `ip:${ip}`]

    const { throttled, retryAfter } = isThrottled(keys)
    if (throttled) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `too many failed attempts — try again in ${Math.ceil(retryAfter / 60)} minute(s)`,
      })
    }

    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.email, input.email) })
    if (!user || !user.isActive || !verifyPassword(input.password, user.passwordHash)) {
      recordFailure(keys)
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid credentials' })
    }
    recordSuccess(keys)

    const session = await createSession(user.id)
    ;(ctx.res as any).setCookie('sid', session.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: session.expiresAt,
    })

    // the client routes straight to the change-password screen when this is true
    return { role: user.role, email: user.email, mustChangePassword: user.mustChangePassword }
  }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    const sid = (ctx.req as any).cookies?.sid as string | undefined
    if (sid) await destroySession(sid)
    ;(ctx.res as any).clearCookie('sid', { path: '/', secure: process.env.NODE_ENV === 'production' })
    return { ok: true }
  }),

  /**
   * Any logged-in user sets their own password. Deliberately uses requireAuth, not
   * requirePerm, so an account holding a temporary password can still reach it — it is
   * the only route a flagged account can use.
   */
  changePassword: publicProcedure
    .use(requireAuth)
    .input(changePasswordInputSchema)
    .mutation(async ({ ctx, input }) => {
      await changeOwnPassword(db, {
        userId: ctx.session.userId,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        keepSessionId: ctx.session.sessionId,
      })
      return { ok: true }
    }),

  viewAsProfiles: publicProcedure.use(requirePerm('admin.*')).query(async () => {
    const users = await db
      .select({
        userId: schema.appUser.id,
        role: schema.appUser.role,
        email: schema.appUser.email,
        displayName: schema.appUser.displayName,
      })
      .from(schema.appUser)
      // View-as is an ADMIN inspection tool, not authentication as the target. New-hire
      // accounts commonly still hold a temporary password; excluding them made the list
      // collapse to the ADMIN's own profile before onboarding was complete.
      .where(eq(schema.appUser.isActive, true))
    return users.sort((a, b) =>
      (a.displayName ?? a.email).localeCompare(b.displayName ?? b.email, undefined, { sensitivity: 'base' }),
    )
  }),

  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.session) return null
    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, ctx.session.userId) })
    if (!user) return null
    return {
      userId: user.id,
      role: user.role,
      email: user.email,
      displayName: user.displayName,
      mustChangePassword: user.mustChangePassword,
    }
  }),
})
