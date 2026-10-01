/**
 * In-memory fixed-window rate limiter (one API process, DECISIONS D-16). Counts reset on restart, which is
 * acceptable for request throttling; durable anti-sybil limits belong in the database.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>()
  private sweeps = 0

  /** Counts one hit for `key`; returns false once more than `max` hits land within `windowMs`. */
  hit(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    if (++this.sweeps % 1000 === 0) this.sweep(now)
    const w = this.windows.get(key)
    if (!w || w.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    w.count += 1
    return w.count <= max
  }

  /** Current count without counting a hit. */
  peek(key: string, now = Date.now()): number {
    const w = this.windows.get(key)
    return w && w.resetAt > now ? w.count : 0
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k)
  }
}

/** D-16 limits for the recipient routes. */
export const LIMITS = {
  /** Mutating claim / Tap Rush / referral requests per signed-in user. */
  perUser: { max: 30, windowMs: 60_000 },
  /** The same requests per client IP (several users can share one IP, e.g. demo Wi-Fi). */
  perIp: { max: 120, windowMs: 60_000 },
} as const
