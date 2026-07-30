import { describe, it, expect } from 'vitest'
import { t } from './router'
import { requirePerm, requireAuth } from './requirePerm'
import type { Context } from './context'

const fakeReqRes = { req: {} as Context['req'], res: {} as Context['res'] }

function session(over: Partial<NonNullable<Context['session']>> = {}): Context['session'] {
  return {
    userId: 'u1',
    role: 'MANAGER',
    mustChangePassword: false,
    sessionId: 's1',
    ...over,
  }
}

describe('requirePerm', () => {
  const guarded = t.procedure.use(requirePerm('rep.override')).query(() => 'ok')
  const router = t.router({ x: guarded })

  it('rejects an unauthenticated context', async () => {
    const caller = t.createCallerFactory(router)({ session: null, ...fakeReqRes })
    await expect(caller.x()).rejects.toThrow(/UNAUTHORIZED/)
  })

  it('rejects BDC (lacks rep.override)', async () => {
    const caller = t.createCallerFactory(router)({ session: session({ role: 'BDC' }), ...fakeReqRes })
    await expect(caller.x()).rejects.toThrow(/FORBIDDEN/)
  })

  it('allows MANAGER', async () => {
    const caller = t.createCallerFactory(router)({ session: session({ role: 'MANAGER' }), ...fakeReqRes })
    await expect(caller.x()).resolves.toBe('ok')
  })

  it('blocks an account holding a temporary password, even with the permission', async () => {
    // the whole point of the forced reset: a temp password is useless against the API,
    // not merely hidden by the UI
    const caller = t.createCallerFactory(router)({
      session: session({ role: 'ADMIN', mustChangePassword: true }),
      ...fakeReqRes,
    })
    await expect(caller.x()).rejects.toThrow(/PASSWORD_CHANGE_REQUIRED/)
  })
})

describe('requireAuth', () => {
  const guarded = t.procedure.use(requireAuth).query(() => 'ok')
  const router = t.router({ x: guarded })

  it('rejects an unauthenticated context', async () => {
    const caller = t.createCallerFactory(router)({ session: null, ...fakeReqRes })
    await expect(caller.x()).rejects.toThrow(/UNAUTHORIZED/)
  })

  it('still allows a flagged account through — this is the change-password escape hatch', async () => {
    const caller = t.createCallerFactory(router)({
      session: session({ role: 'REP', mustChangePassword: true }),
      ...fakeReqRes,
    })
    await expect(caller.x()).resolves.toBe('ok')
  })
})
