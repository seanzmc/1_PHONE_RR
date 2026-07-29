import { useEffect, useRef } from 'react'
import { connectBoardSocket } from './realtime'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000/trpc'
const WS_BASE = API_BASE.replace(/^http/, 'ws').replace(/\/trpc$/, '')

export function useBoardRealtime(onAssignment: () => void): void {
  const callbackRef = useRef(onAssignment)
  callbackRef.current = onAssignment

  useEffect(() => {
    const handle = connectBoardSocket({
      url: `${WS_BASE}/ws/board`,
      onAssignment: () => callbackRef.current(),
    })
    return () => handle.close()
  }, [])
}
