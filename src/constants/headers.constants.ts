/**
 * Standard rate limit HTTP response headers.
 * Based on draft-ietf-httpapi-ratelimit-headers.
 */
export const RateLimitHeaders = {
  LIMIT: 'X-RateLimit-Limit',
  REMAINING: 'X-RateLimit-Remaining',
  RESET: 'X-RateLimit-Reset',
  RETRY_AFTER: 'Retry-After',
} as const;
