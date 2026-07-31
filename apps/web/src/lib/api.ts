// Relative in both environments: production serves the app from the API's own origin, and
// development proxies /trpc through Vite (see vite.config.ts). Same-origin everywhere means
// the session cookie is always sent and there is no CORS or cross-site cookie config.
const API_BASE = import.meta.env.VITE_API_BASE ?? '/trpc'
let viewAsUserId: string | null = null

export function configureViewAs(userId: string | null): void {
  viewAsUserId = userId
}

function requestHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return viewAsUserId ? { ...extra, 'x-phoneup-view-as': viewAsUserId } : extra
}

async function handle(res: Response) {
  const body = await res.json()
  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `request failed: ${res.status}`)
  }
  return body.result.data
}

export async function query<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/${path}`, {
    credentials: 'include',
    headers: requestHeaders(),
  })
  return handle(res)
}

export async function mutate<T = unknown>(path: string, input?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: requestHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(input ?? {}),
  })
  return handle(res)
}
