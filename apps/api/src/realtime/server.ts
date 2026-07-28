import type { Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { bus } from './bus'

export function attachRealtimeServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/board' })

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
