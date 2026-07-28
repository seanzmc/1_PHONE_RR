import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { WebSocket } from 'ws'
import { attachRealtimeServer } from './server'
import { publishAssignment } from './bus'

let httpServer: Server
let port: number

beforeAll(async () => {
  httpServer = createServer()
  attachRealtimeServer(httpServer)
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
