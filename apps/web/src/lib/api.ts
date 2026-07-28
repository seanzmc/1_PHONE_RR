const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000/trpc'

async function handle(res: Response) {
  const body = await res.json()
  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `request failed: ${res.status}`)
  }
  return body.result.data
}

export async function query<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/${path}`, { credentials: 'include' })
  return handle(res)
}

export async function mutate<T = unknown>(path: string, input?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
  })
  return handle(res)
}
