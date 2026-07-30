/**
 * In-process login throttle.
 *
 * Temporary passwords are short and human-speakable, so the defence against online
 * guessing has to be rate limiting rather than length. Failed logins are counted per
 * email and per source IP; once a bucket trips, further attempts are refused for a
 * cooldown even if the credentials are right.
 *
 * In-process (a Map, not Redis) deliberately — single API instance at this scale, same
 * reasoning as the in-process realtime bus in CLAUDE.md. A restart clears the counters,
 * which is acceptable: it costs an attacker far more to force a restart than to wait.
 */

const MAX_FAILURES = 8
const WINDOW_MS = 15 * 60 * 1000 // failures older than this are forgotten
const LOCKOUT_MS = 15 * 60 * 1000

type Bucket = { failures: number[]; lockedUntil: number }

const buckets = new Map<string, Bucket>()

function bucketFor(key: string): Bucket {
  let b = buckets.get(key)
  if (!b) {
    b = { failures: [], lockedUntil: 0 }
    buckets.set(key, b)
  }
  return b
}

function prune(b: Bucket, now: number): void {
  b.failures = b.failures.filter((t) => now - t < WINDOW_MS)
}

/** Seconds remaining before `key` may attempt again, or 0 when not throttled. */
export function retryAfterSeconds(key: string, now = Date.now()): number {
  const b = buckets.get(key)
  if (!b) return 0
  if (b.lockedUntil > now) return Math.ceil((b.lockedUntil - now) / 1000)
  return 0
}

/** True when any of the supplied keys is currently locked out. */
export function isThrottled(keys: string[], now = Date.now()): { throttled: boolean; retryAfter: number } {
  let retryAfter = 0
  for (const k of keys) retryAfter = Math.max(retryAfter, retryAfterSeconds(k, now))
  return { throttled: retryAfter > 0, retryAfter }
}

export function recordFailure(keys: string[], now = Date.now()): void {
  for (const key of keys) {
    const b = bucketFor(key)
    prune(b, now)
    b.failures.push(now)
    if (b.failures.length >= MAX_FAILURES) {
      b.lockedUntil = now + LOCKOUT_MS
      b.failures = []
    }
  }
}

/** Clear counters for these keys after a successful login. */
export function recordSuccess(keys: string[]): void {
  for (const key of keys) buckets.delete(key)
}

/** Test seam. */
export function resetThrottle(): void {
  buckets.clear()
}
