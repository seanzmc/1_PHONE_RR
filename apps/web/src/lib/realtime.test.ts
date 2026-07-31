import { describe, expect, it, vi } from 'vitest'
import { connectBoardSocket, resolveBoardSocketUrl } from './realtime'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closeCalls = 0
  url: string

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  close() {
    this.closeCalls++
    this.onclose?.()
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

function reset() {
  FakeWebSocket.instances = []
}

describe('connectBoardSocket', () => {
  it('calls onAssignment when an ASSIGNMENT message arrives', () => {
    reset()
    const onAssignment = vi.fn()
    connectBoardSocket({
      url: 'ws://localhost:3000/ws/board',
      onAssignment,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })

    const socket = FakeWebSocket.instances[0]
    socket.emitMessage({ type: 'ASSIGNMENT', payload: { leadId: 'abc' } })

    expect(onAssignment).toHaveBeenCalledTimes(1)
  })

  it('ignores messages that are not type ASSIGNMENT', () => {
    reset()
    const onAssignment = vi.fn()
    connectBoardSocket({
      url: 'ws://localhost:3000/ws/board',
      onAssignment,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    })

    const socket = FakeWebSocket.instances[0]
    socket.emitMessage({ type: 'PING' })

    expect(onAssignment).not.toHaveBeenCalled()
  })

  it('reconnects after an unexpected close', () => {
    reset()
    vi.useFakeTimers()
    const onAssignment = vi.fn()
    connectBoardSocket({
      url: 'ws://localhost:3000/ws/board',
      onAssignment,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      reconnectDelayMs: 1000,
    })

    expect(FakeWebSocket.instances).toHaveLength(1)
    FakeWebSocket.instances[0].close()
    vi.advanceTimersByTime(1000)

    expect(FakeWebSocket.instances).toHaveLength(2)
    vi.useRealTimers()
  })

  it('does not reconnect after close() is called by the caller', () => {
    reset()
    vi.useFakeTimers()
    const onAssignment = vi.fn()
    const handle = connectBoardSocket({
      url: 'ws://localhost:3000/ws/board',
      onAssignment,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      reconnectDelayMs: 1000,
    })

    handle.close()
    vi.advanceTimersByTime(5000)

    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].closeCalls).toBe(1)
    vi.useRealTimers()
  })
})

describe('resolveBoardSocketUrl', () => {
  it('resolves a same-origin API path to a secure WebSocket URL', () => {
    expect(resolveBoardSocketUrl('/trpc', 'https://stingraysales.net')).toBe(
      'wss://stingraysales.net/ws/board',
    )
  })

  it('preserves an absolute local-development API host', () => {
    expect(resolveBoardSocketUrl('http://localhost:3000/trpc', 'http://localhost:5173')).toBe(
      'ws://localhost:3000/ws/board',
    )
  })
})
