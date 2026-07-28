import { TRPCError } from '@trpc/server'
import { hasPermission, type Permission } from '@phoneup/contracts'
import { t } from './router'

export function requirePerm(perm: Permission) {
  return t.middleware(({ ctx, next }) => {
    if (!ctx.session) throw new TRPCError({ code: 'UNAUTHORIZED' })
    if (!hasPermission(ctx.session.role, perm)) throw new TRPCError({ code: 'FORBIDDEN' })
    return next({ ctx: { ...ctx, session: ctx.session } })
  })
}
