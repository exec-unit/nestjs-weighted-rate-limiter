import type { RateLimitResult } from './rate-limit-result.interface.js';

/**
 * Abstract store contract for the token bucket implementation.
 *
 * `RedisStore` is the default. Override `RATE_LIMIT_STORE_TOKEN` to provide
 * a custom implementation — useful for testing with an in-memory store.
 */
export interface IRateLimitStore {
  consume(
    key: string,
    capacity: number,
    refillRate: number,
    cost: number,
  ): Promise<RateLimitResult>;
}
