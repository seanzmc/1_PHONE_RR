import { useEffect, useRef } from 'react'
import { connectBoardSocket, resolveBoardSocketUrl } from './realtime'

// see api.ts — relative in both environments so the session cookie reaches the socket
const API_BASE = import.meta.env.VITE_API_BASE ?? '/trpc'

export function useBoardRealtime(onAssignment: () => void): void {
  const callbackRef = useRef(onAssignment)
  callbackRef.current = onAssignment

  useEffect(() => {
    const handle = connectBoardSocket({
      url: resolveBoardSocketUrl(API_BASE, window.location.origin),
      onAssignment: () => callbackRef.current(),
    })
    return () => handle.close()
  }, [])
}
