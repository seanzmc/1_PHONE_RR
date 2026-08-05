import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { loadSession } from '../auth/session'
import type { Role } from '@phoneup/contracts'

type SessionContext = { userId: string; role: Role; mustChangePassword: boolean; sessionId: string }

export type Context = {
  session: SessionContext | null
  viewAs?: { adminUserId: string; targetUserId: string } | null
  req: CreateFastifyContextOptions['req']
  res: CreateFastifyContextOptions['res']
}

export async function createContext({ req, res }: CreateFastifyContextOptions): Promise<Context> {
  const sid = (req as any).cookies?.sid as string | undefined
  const realSession = sid ? await loadSession(sid) : null
  const header = (req as any).headers?.['x-phoneup-view-as']
  const targetUserId = typeof header === 'string' ? header : null
  if (!targetUserId) return { session: realSession, viewAs: null, req, res }

  if (!realSession || realSession.role !== 'ADMIN') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'only an ADMIN may view as another profile' })
  }
  if ((req as any).method !== 'GET') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'view-as is read-only; exit view-as before making changes' })
  }

  const target = await db.query.appUser.findFirst({ where: eq(schema.appUser.id, targetUserId) })
  if (!target?.isActive) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'view-as profile is not available' })
  }
  // Same rule as userManagement.list and viewAsProfiles: the protected owner account is
  // invisible to everyone but itself. The picker already filters it out, but the header is a
  // separate server-side entry point and must enforce this independently — a UI-only filter
  // is exactly the shape CLAUDE.md forbids for the password gate.
  if (target.isProtected && target.id !== realSession.userId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'view-as profile is not available' })
  }
  const session: SessionContext = {
    userId: target.id,
    role: target.role as Role,
    // The ADMIN is inspecting this real profile through their own authenticated session.
    // The target's first-login password gate is irrelevant here; all mutations stay blocked.
    mustChangePassword: false,
    // The target never owns the session. Mutations are blocked above, and retaining the
    // ADMIN's session id prevents a synthetic credential from entering the context.
    sessionId: realSession.sessionId,
  }
  return {
    session,
    viewAs: { adminUserId: realSession.userId, targetUserId: target.id },
    req,
    res,
  }
}
