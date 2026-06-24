/** Metadata key used to store the WeightedLimit policy on a route handler. */
export const WEIGHTED_LIMIT_METADATA = 'weighted_rate_limit:policy';

/**
 * Metadata key set by `@SkipWeightedLimit()` to explicitly opt a route or
 * controller out of weighted rate limiting even when the guard is global.
 */
export const SKIP_WEIGHTED_LIMIT_METADATA = 'weighted_rate_limit:skip';

/** DI token for the ioredis client instance managed by the module. */
export const REDIS_CLIENT_TOKEN = 'WEIGHTED_RATE_LIMITER_REDIS_CLIENT';

/** DI token for the module options object. */
export const MODULE_OPTIONS_TOKEN = 'WEIGHTED_RATE_LIMITER_OPTIONS';

/**
 * DI token for the rate limit store implementation.
 *
 * Override this token in your own module to swap RedisStore for a custom
 * store (e.g., in-memory for testing, DynamoDB, etc.).
 *
 * @example
 * Override with custom store:
 * ```typescript
 *  { provide: RATE_LIMIT_STORE_TOKEN, useClass: MyCustomStore }
 * ```
 */
export const RATE_LIMIT_STORE_TOKEN = 'WEIGHTED_RATE_LIMITER_STORE';
