import { describe, it, expect } from 'vitest'
import { t } from './router'
import { requirePerm } from './requirePerm'

describe('requirePerm', () => {
  const guarded = t.procedure.use(requirePerm('rep.override')).query(() => 'ok')
  const router = t.router({ x: guarded })

  it('rejects an unauthenticated context', async () => {
    const caller = t.createCallerFactory(router)({ session: null })
    await expect(caller.x()).rejects.toThrow(/UNAUTHORIZED/)
  })

  it('rejects BDC (lacks rep.override)', async () => {
    const caller = t.createCallerFactory(router)({ session: { userId: 'u1', role: 'BDC' } })
    await expect(caller.x()).rejects.toThrow(/FORBIDDEN/)
  })

  it('allows MANAGER', async () => {
    const caller = t.createCallerFactory(router)({ session: { userId: 'u1', role: 'MANAGER' } })
    await expect(caller.x()).resolves.toBe('ok')
  })
})
