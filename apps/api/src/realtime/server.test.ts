import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { WebSocket } from 'ws'
import { eq } from 'drizzle-orm'
import { db, schema } from '@phoneup/db'
import { attachRealtimeServer, authorizeBoardSocket } from './server'
import { createSession } from '../auth/session'
import { publishAssignment } from './bus'

let httpServer: Server
let port: number

// The fan-out tests care about broadcast, not auth, so they run behind an authorizer that
// always accepts. The auth behaviour itself is covered against the real one below.
beforeAll(async () => {
  httpServer = createServer()
  attachRealtimeServer(httpServer, { authorize: async () => true })
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  port = (httpServer.address() as any).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
})

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/board`)
    ws.on('open', () => resolve(ws))
  })
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
  })
}

describe('realtime board fan-out', () => {
  it('broadcasts an assignment event to all connected board clients', async () => {
    const clientA = await connect(port)
    const clientB = await connect(port)

    const messageA = nextMessage(clientA)
    const messageB = nextMessage(clientB)

    publishAssignment({ leadId: 'lead-1', assignedRepId: 'rep-1' })

    const [a, b] = await Promise.all([messageA, messageB])
    expect(a).toEqual({ type: 'ASSIGNMENT', payload: { leadId: 'lead-1', assignedRepId: 'rep-1' } })
    expect(b).toEqual({ type: 'ASSIGNMENT', payload: { leadId: 'lead-1', assignedRepId: 'rep-1' } })

    clientA.close()
    clientB.close()
  })
})

/**
 * The board socket streams the same data the HTTP board routes do. It used to accept any
 * anonymous connection, so it was the one door with no lock on it.
 */
describe('board socket authorization', () => {
  const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as any

  async function userWithSession(
    role: 'ADMIN' | 'MANAGER' | 'BDC' | 'REP',
    opts: { mustChangePassword?: boolean; isActive?: boolean } = {},
  ): Promise<string> {
    const [user] = await db
      .insert(schema.appUser)
      .values({
        email: `ws-auth-${role}-${Date.now()}-${Math.round(performance.now() * 1000)}@dealership.test`,
        passwordHash: 'x:y',
        role,
        mustChangePassword: opts.mustChangePassword ?? false,
        isActive: opts.isActive ?? true,
      })
      .returning()
    const session = await createSession(user.id)
    return session.id
  }

  it('rejects a request with no cookie at all', async () => {
    expect(await authorizeBoardSocket(req())).toBe(false)
  })

  it('rejects a cookie header with no sid', async () => {
    expect(await authorizeBoardSocket(req('other=value'))).toBe(false)
  })

  it('rejects an unknown session id', async () => {
    expect(await authorizeBoardSocket(req('sid=not-a-real-session'))).toBe(false)
  })

  it('accepts a valid session for every role that holds board.view', async () => {
    for (const role of ['ADMIN', 'MANAGER', 'BDC', 'REP'] as const) {
      const sid = await userWithSession(role)
      expect(await authorizeBoardSocket(req(`sid=${sid}`))).toBe(true)
    }
  })

  // same gate as requirePerm: a temporary password reaches nothing but changePassword
  it('rejects a session that still holds a temporary password', async () => {
    const sid = await userWithSession('MANAGER', { mustChangePassword: true })
    expect(await authorizeBoardSocket(req(`sid=${sid}`))).toBe(false)
  })

  it('rejects a session whose account has been deactivated', async () => {
    const sid = await userWithSession('BDC')
    const session = await db.query.session.findFirst({ where: eq(schema.session.id, sid) })
    await db.update(schema.appUser).set({ isActive: false }).where(eq(schema.appUser.id, session!.userId))
    expect(await authorizeBoardSocket(req(`sid=${sid}`))).toBe(false)
  })

  it('rejects an expired session', async () => {
    const sid = await userWithSession('MANAGER')
    await db
      .update(schema.session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.session.id, sid))
    expect(await authorizeBoardSocket(req(`sid=${sid}`))).toBe(false)
  })

  it('refuses the upgrade with 401 when the authorizer says no', async () => {
    const closedServer = createServer()
    attachRealtimeServer(closedServer, { authorize: async () => false })
    await new Promise<void>((resolve) => closedServer.listen(0, resolve))
    const closedPort = (closedServer.address() as any).port

    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${closedPort}/ws/board`)
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode!))
      ws.on('open', () => reject(new Error('socket opened despite a rejecting authorizer')))
    })

    expect(status).toBe(401)
    await new Promise<void>((resolve) => closedServer.close(() => resolve()))
  })
})
