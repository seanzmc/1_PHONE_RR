import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { verifyPassword } from '../auth/password'
import { createSession, destroySession } from '../auth/session'
import { publicProcedure, router } from '../trpc/router'

const loginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const authRouter = router({
  login: publicProcedure.input(loginInputSchema).mutation(async ({ ctx, input }) => {
    const user = await db.query.appUser.findFirst({ where: eq(schema.appUser.email, input.email) })
    if (!user || !user.isActive || !verifyPassword(input.password, user.passwordHash)) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid credentials' })
    }

    const session = await createSession(user.id)
    ;(ctx.res as any).setCookie('sid', session.id, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: session.expiresAt,
    })

    return { role: user.role, email: user.email }
  }),

  logout: publicProcedure.mutation(async ({ ctx }) => {
    const sid = (ctx.req as any).cookies?.sid as string | undefined
    if (sid) await destroySession(sid)
    ;(ctx.res as any).clearCookie('sid', { path: '/', secure: process.env.NODE_ENV === 'production' })
    return { ok: true }
  }),

  me: publicProcedure.query(({ ctx }) => ctx.session),
})
