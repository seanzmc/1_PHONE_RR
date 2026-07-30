import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    /**
     * Proxy the API and the board socket so development is same-origin, exactly like
     * production (where the API serves apps/web/dist itself).
     *
     * This is not just convenience: the session cookie is sameSite=lax, and a WebSocket
     * handshake is not a top-level navigation, so a cross-origin socket from :5173 to
     * :3000 would carry no cookie and be rejected by the board socket's auth check.
     */
    proxy: {
      '/trpc': { target: 'http://localhost:3000' },
      '/ws/board': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
