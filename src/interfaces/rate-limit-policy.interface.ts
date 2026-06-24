import type { ExecutionContext } from '@nestjs/common';

/** Any function that derives a value from the current NestJS ExecutionContext. */
export type ContextResolver<T> = (ctx: ExecutionContext) => T | Promise<T>;

/**
 * Rate limiting policy attached to a route via `@WeightedLimit()`.
 *
 * All fields accept either a static value or a `ContextResolver` — a function
 * that receives the `ExecutionContext` and returns the value dynamically.
 * This is the mechanism for business-aware rate limiting.
 */
export interface RateLimitPolicy {
  /**
   * Maximum token bucket capacity (burst limit).
   * @example 10_000
   */
  capacity: number | ContextResolver<number>;

  /**
   * Tokens restored per second (sustained throughput limit).
   * @example 500
   */
  refillRate: number | ContextResolver<number>;

  /**
   * Resolves the bucket key — identifies who is being limited.
   * The value is automatically namespaced with `keyPrefix` internally.
   * @example ctx => `org:${ctx.switchToHttp().getRequest().user.orgId}`
   */
  key: ContextResolver<string>;

  /**
   * Token cost of the current request. Defaults to `1`.
   * @example ctx => ctx.switchToHttp().getRequest<Request>().body.rows * 2
   */
  cost?: number | ContextResolver<number>;

  /**
   * Per-route override of the global `failOpen` setting.
   * When `true`, passes the request if Redis is down.
   */
  failOpen?: boolean;
}
