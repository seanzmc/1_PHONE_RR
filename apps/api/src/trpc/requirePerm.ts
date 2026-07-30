import { TRPCError } from '@trpc/server'
import { hasPermission, type Permission } from '@phoneup/contracts'
import { t } from './router'

/**
 * Gate a procedure on a permission.
 *
 * Also enforces the forced password change server-side: an account holding an
 * admin-issued temporary password can do nothing except change it (and read auth.me /
 * log out, which don't use this middleware). Enforcing it here rather than only in the
 * UI means a temp password is useless against the API directly.
 */
export function requirePerm(perm: Permission) {
  return t.middleware(({ ctx, next }) => {
    if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' })
    if (ctx.session.mustChangePassword) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'PASSWORD_CHANGE_REQUIRED: set a new password before continuing',
      })
    }
    if (!hasPermission(ctx.session.role, perm)) throw new TRPCError({ code: 'FORBIDDEN' })
    return next({ ctx: { ...ctx, session: ctx.session } })
  })
}

/**
 * Authenticated but NOT subject to the password-change gate — used only by the
 * change-password route itself, which is the one thing a flagged account must be able
 * to reach.
 */
export const requireAuth = t.middleware(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' })
  return next({ ctx: { ...ctx, session: ctx.session } })
})
