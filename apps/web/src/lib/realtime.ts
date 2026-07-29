export type BoardSocketHandle = { close: () => void }

export function resolveBoardSocketUrl(apiBase: string, pageOrigin: string): string {
  const url = new URL(apiBase, pageOrigin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = url.pathname.replace(/\/trpc\/?$/, '/ws/board')
  return url.toString()
}

export function connectBoardSocket({
  url,
  onAssignment,
  WebSocketImpl = WebSocket,
  reconnectDelayMs = 2000,
}: {
  url: string
  onAssignment: () => void
  WebSocketImpl?: new (url: string) => WebSocket
  reconnectDelayMs?: number
}): BoardSocketHandle {
  let closedByCaller = false
  let socket: WebSocket
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  function open() {
    socket = new WebSocketImpl(url)
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data as string)
      if (data?.type === 'ASSIGNMENT') onAssignment()
    }
    socket.onclose = () => {
      if (!closedByCaller) {
        reconnectTimer = setTimeout(open, reconnectDelayMs)
      }
    }
  }

  open()

  return {
    close() {
      closedByCaller = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      socket.close()
    },
  }
}
