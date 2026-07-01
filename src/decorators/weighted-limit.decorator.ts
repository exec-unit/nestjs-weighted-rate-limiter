import { SetMetadata } from '@nestjs/common';
import { WEIGHTED_LIMIT_METADATA } from '../constants/metadata.constants.js';
import type { RateLimitPolicy } from '../interfaces/rate-limit-policy.interface.js';

/**
 * Route-level decorator that attaches a weighted rate limiting policy.
 *
 * The `WeightedRateLimiterGuard` reads this metadata at runtime to enforce limits.
 * Can be applied to a method or an entire controller class.
 *
 * @example
 * Usage with dynamic policies:
 * ```typescript
 * const policy: RateLimitPolicy = {
 *   capacity: 100_000,
 *   refillRate: 1_000,
 *   key: (ctx) => `org:${ctx.switchToHttp().getRequest().user.orgId}`,
 *   cost: (ctx) => ctx.switchToHttp().getRequest<Request>().body.rows * 2,
 * };
 * ```
 */
export const WeightedLimit = (policy: RateLimitPolicy): MethodDecorator & ClassDecorator =>
  SetMetadata(WEIGHTED_LIMIT_METADATA, policy);
