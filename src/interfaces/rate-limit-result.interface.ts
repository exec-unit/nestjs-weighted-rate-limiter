/**
 * Result returned by the Redis store after executing the token bucket script.
 * Represents the atomic outcome of the check-and-consume operation.
 */
export interface RateLimitResult {
  /**
   * Whether the request was allowed.
   * `true` — tokens were deducted; `false` — insufficient tokens.
   */
  allowed: boolean;

  /** Total bucket capacity (matches the policy `capacity` value). */
  limit: number;

  /**
   * Remaining tokens in the bucket after this request.
   * When `allowed` is `false`, this is the current token count before refill.
   */
  remaining: number;

  /**
   * Unix timestamp (seconds) when the bucket will be fully refilled.
   * Used to set the `X-RateLimit-Reset` header.
   */
  resetAt: number;

  /**
   * Seconds to wait before retrying.
   * Only meaningful when `allowed` is `false`.
   * Used to set the `Retry-After` header.
   */
  retryAfter: number;
}
