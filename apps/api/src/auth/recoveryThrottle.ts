const MAX_REQUESTS = 3
const WINDOW_MS = 15 * 60 * 1000

const requests = new Map<string, number[]>()

function recentRequests(key: string, now: number): number[] {
  const recent = (requests.get(key) ?? []).filter((time) => now - time < WINDOW_MS)
  if (recent.length > 0) requests.set(key, recent)
  else requests.delete(key)
  return recent
}

export function checkRecoveryThrottle(
  keys: string[],
  now = Date.now(),
): { throttled: boolean; retryAfter: number } {
  let retryAfter = 0
  for (const key of keys) {
    const recent = recentRequests(key, now)
    if (recent.length < MAX_REQUESTS) continue
    retryAfter = Math.max(retryAfter, Math.ceil((recent[0] + WINDOW_MS - now) / 1000))
  }
  return { throttled: retryAfter > 0, retryAfter }
}

export function recordRecoveryRequest(keys: string[], now = Date.now()): void {
  for (const key of keys) {
    const recent = recentRequests(key, now)
    recent.push(now)
    requests.set(key, recent)
  }
}

export function resetRecoveryThrottle(): void {
  requests.clear()
}
