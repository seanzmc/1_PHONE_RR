import { describe, it, expect } from 'vitest'
import { t } from '../trpc/router'
import { userManagementRouter } from './userManagement'
import type { Context } from '../trpc/context'

const fakeReqRes = { req: {} as Context['req'], res: {} as Context['res'] }

describe('userManagementRouter', () => {
  it('rejects BDC', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: { userId: 'u1', role: 'BDC' },
      ...fakeReqRes,
    })
    await expect(caller.list()).rejects.toThrow(/FORBIDDEN/)
  })

  it('rejects REP', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: { userId: 'u1', role: 'REP' },
      ...fakeReqRes,
    })
    await expect(caller.list()).rejects.toThrow(/FORBIDDEN/)
  })

  it('allows MANAGER to list accounts', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: { userId: 'u1', role: 'MANAGER' },
      ...fakeReqRes,
    })
    await expect(caller.list()).resolves.toBeInstanceOf(Array)
  })

  it('allows ADMIN to list accounts', async () => {
    const caller = t.createCallerFactory(userManagementRouter)({
      session: { userId: 'u1', role: 'ADMIN' },
      ...fakeReqRes,
    })
    await expect(caller.list()).resolves.toBeInstanceOf(Array)
  })
})
