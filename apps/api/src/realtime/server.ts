import type { Server, IncomingMessage } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
// the `parse` @fastify/cookie exports is bound to a fastify instance and throws when
// called standalone, so parse the upgrade request's header with the underlying library
import { parseCookie } from 'cookie'
import { hasPermission } from '@phoneup/contracts'
import { loadSession } from '../auth/session'
import { bus } from './bus'

/**
 * Decides whether an upgrade request may subscribe to the board feed.
 *
 * Injectable so tests can drive the accept/reject paths without a session in the database.
 */
export type BoardSocketAuthorizer = (req: IncomingMessage) => Promise<boolean>

/**
 * Same three checks as requirePerm, in the same order — the socket streams the same board
 * data the HTTP routes do, so it cannot be the one door with no lock on it.
 */
export const authorizeBoardSocket: BoardSocketAuthorizer = async (req) => {
  const header = req.headers.cookie
  if (!header) return false

  const sid = parseCookie(header).sid
  if (!sid) return false

  const session = await loadSession(sid)
  if (!session) return false
  if (session.mustChangePassword) return false
  return hasPermission(session.role, 'board.view')
}

export function attachRealtimeServer(
  httpServer: Server,
  opts: { authorize?: BoardSocketAuthorizer } = {},
): WebSocketServer {
  const authorize = opts.authorize ?? authorizeBoardSocket

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/board',
    verifyClient: ({ req }, done) => {
      authorize(req).then(
        (ok) => done(ok, 401, 'Unauthorized'),
        () => done(false, 500, 'Internal Server Error'),
      )
    },
  })

  wss.on('connection', (socket) => {
    const onAssignment = (payload: unknown) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ASSIGNMENT', payload }))
      }
    }
    bus.on('assignment', onAssignment)

    socket.on('close', () => {
      bus.off('assignment', onAssignment)
    })
  })

  return wss
}
