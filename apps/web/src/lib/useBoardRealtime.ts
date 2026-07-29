import { useEffect, useRef } from 'react'
import { connectBoardSocket, resolveBoardSocketUrl } from './realtime'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000/trpc'

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
