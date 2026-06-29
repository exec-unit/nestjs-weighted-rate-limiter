import type { IRateLimitStore } from '../../src/interfaces/rate-limit-store.interface.js';
import type { RateLimitResult } from '../../src/interfaces/rate-limit-result.interface.js';

interface Bucket {
  tokens: number;
  lastRefill: number; // Unix timestamp (seconds)
}

/**
 * In-memory token bucket implementation for unit tests.
 *
 * Replicates the same algorithm as the Redis Lua script so that Guard and
 * Service unit tests produce realistic, consistent results without requiring
 * a running Redis instance.
 *
 * Usage:
 * ```ts
 * let store: InMemoryRateLimitStore;
 * beforeEach(() => { store = new InMemoryRateLimitStore(); });
 * ```
 */
export class InMemoryRateLimitStore implements IRateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  consume(
    key: string,
    capacity: number,
    refillRate: number,
    cost: number,
  ): Promise<RateLimitResult> {
    const now = Date.now() / 1_000;
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: capacity, lastRefill: now };

    const elapsed = Math.max(0, now - bucket.lastRefill);
    const refilled =
      refillRate > 0 ? Math.min(capacity, bucket.tokens + elapsed * refillRate) : bucket.tokens;

    if (refilled >= cost) {
      const remaining = refilled - cost;
      this.buckets.set(key, { tokens: remaining, lastRefill: now });

      const secondsToFull = refillRate > 0 ? (capacity - remaining) / refillRate : 0;

      return Promise.resolve({
        allowed: true,
        remaining,
        limit: capacity,
        resetAt: Math.ceil(now + secondsToFull),
        retryAfter: 0,
      });
    }

    const deficit = cost - refilled;
    this.buckets.set(key, { tokens: refilled, lastRefill: now });

    const retryAfter = refillRate > 0 ? Math.ceil(deficit / refillRate) : 0;
    const secondsToFull = refillRate > 0 ? (capacity - refilled) / refillRate : 0;

    return Promise.resolve({
      allowed: false,
      remaining: refilled,
      limit: capacity,
      resetAt: Math.ceil(now + secondsToFull),
      retryAfter,
    });
  }

  /** Returns current token count for a key — useful for assertions. */
  getTokens(key: string): number | undefined {
    return this.buckets.get(key)?.tokens;
  }
}
