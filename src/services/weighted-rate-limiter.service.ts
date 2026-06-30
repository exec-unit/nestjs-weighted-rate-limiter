import { Injectable, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  WEIGHTED_LIMIT_METADATA,
  MODULE_OPTIONS_TOKEN,
  RATE_LIMIT_STORE_TOKEN,
} from '../constants/metadata.constants.js';
import type {
  RateLimitPolicy,
  ContextResolver,
} from '../interfaces/rate-limit-policy.interface.js';
import type { RateLimitResult } from '../interfaces/rate-limit-result.interface.js';
import type { IRateLimitStore } from '../interfaces/rate-limit-store.interface.js';
import type { WeightedRateLimiterOptions } from '../interfaces/module-options.interface.js';
import { NoopMetrics, type RateLimitMetrics } from '../observability/metrics.js';
import type { ExecutionContext } from '@nestjs/common';

/** What the guard receives after evaluation — the result plus context for header/error handling. */
export interface PolicyEvaluation {
  result: RateLimitResult;
  /** Resolved per-request: route-level failOpen overrides the module default. */
  failOpen: boolean;
}

/**
 * Orchestrates rate limit evaluation for a single request.
 *
 * Reads `@WeightedLimit()` metadata, resolves all dynamic policy values,
 * calls the store, and fires observability events. The guard stays thin.
 */
@Injectable()
export class WeightedRateLimiterService {
  private readonly metrics: RateLimitMetrics;

  constructor(
    private readonly reflector: Reflector,
    @Inject(RATE_LIMIT_STORE_TOKEN) private readonly store: IRateLimitStore,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: WeightedRateLimiterOptions,
  ) {
    this.metrics = options.metrics ?? new NoopMetrics();
  }

  /**
   * Evaluates the rate limit for the given execution context.
   * Returns `null` when the route has no `@WeightedLimit()` — guard passes through.
   */
  async evaluate(ctx: ExecutionContext): Promise<PolicyEvaluation | null> {
    // Method metadata takes precedence over class-level metadata
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(
      WEIGHTED_LIMIT_METADATA,
      [ctx.getHandler(), ctx.getClass()],
    );

    if (!policy) return null;

    const [key, cost, capacity, refillRate] = await Promise.all([
      resolveContextValue(policy.key, ctx),
      resolveContextValue(policy.cost ?? 1, ctx),
      resolveContextValue(policy.capacity, ctx),
      resolveContextValue(policy.refillRate, ctx),
    ]);

    // Validate resolved values — negative or zero capacity is a misconfiguration
    // that causes undefined Lua behavior. Throw early so the guard's fail-open/closed
    // logic handles it the same way as a store error.
    if (!key) throw new Error('WeightedRateLimiter: resolved key must be a non-empty string');
    if (capacity <= 0)
      throw new Error(`WeightedRateLimiter: capacity must be > 0, got ${capacity}`);
    if (refillRate < 0)
      throw new Error(`WeightedRateLimiter: refillRate must be >= 0, got ${refillRate}`);
    if (cost < 0) throw new Error(`WeightedRateLimiter: cost must be >= 0, got ${cost}`);

    const result = await this.store.consume(key, capacity, refillRate, cost);

    if (result.allowed) {
      this.metrics.onAllowed(key, cost, result.remaining);
    } else {
      this.metrics.onRejected(key, cost, result.retryAfter);
    }

    return {
      result,
      failOpen: policy.failOpen ?? this.options.failOpen ?? false,
    };
  }

  /**
   * Reads the `@WeightedLimit()` policy metadata for the given context without
   * touching the store. Used by the guard to recover per-route `failOpen` when
   * the store throws before `evaluate()` can return a full `PolicyEvaluation`.
   */
  resolvePolicy(ctx: ExecutionContext): RateLimitPolicy | null {
    return (
      this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(WEIGHTED_LIMIT_METADATA, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? null
    );
  }

  reportError(key: string, error: Error): void {
    this.metrics.onError(key, error);
  }
}

function resolveContextValue<T>(
  value: T | ContextResolver<T>,
  ctx: ExecutionContext,
): T | Promise<T> {
  return typeof value === 'function' ? (value as ContextResolver<T>)(ctx) : value;
}
