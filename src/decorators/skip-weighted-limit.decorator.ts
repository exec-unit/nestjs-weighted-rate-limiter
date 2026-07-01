import { SetMetadata } from '@nestjs/common';
import { SKIP_WEIGHTED_LIMIT_METADATA } from '../constants/metadata.constants.js';

/**
 * Marks a route handler or an entire controller as exempt from the
 * `WeightedRateLimiterGuard`, even when the guard is registered globally
 * via `APP_GUARD`.
 *
 * Useful for health-check endpoints, internal probes, or any route that
 * must never be throttled regardless of the parent controller's policy.
 *
 * When applied to a method, it overrides a class-level `@WeightedLimit()`
 * policy — the method is skipped while other methods on the same controller
 * remain rate-limited.
 *
 * See README.md for full controller and route handler usage examples.
 */
export const SkipWeightedLimit = (): MethodDecorator & ClassDecorator =>
  SetMetadata(SKIP_WEIGHTED_LIMIT_METADATA, true);
