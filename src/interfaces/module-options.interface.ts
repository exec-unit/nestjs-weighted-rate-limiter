import type {
  DynamicModule,
  ForwardReference,
  InjectionToken,
  OptionalFactoryDependency,
  Type,
} from '@nestjs/common';
import type { ContextResolver } from './rate-limit-policy.interface.js';
import type { RateLimitMetrics } from '../observability/metrics.js';
import type { Redis, RedisOptions, ClusterOptions } from 'ioredis';

export interface SingleRedisOptions {
  type: 'single';
  options: RedisOptions;
}

export interface ClusterRedisOptions {
  type: 'cluster';
  startupNodes: Array<{ host: string; port: number }>;
  options?: ClusterOptions;
}

/**
 * Use this when the application already manages its own Redis connection.
 * The provided client is used as-is — the library won't close it on shutdown.
 */
export interface ExistingRedisOptions {
  type: 'existing';
  client: Redis;
}

export type RedisConnectionOptions =
  SingleRedisOptions | ClusterRedisOptions | ExistingRedisOptions;

/**
 * Global configuration for `WeightedRateLimiterModule`.
 * Route-level `@WeightedLimit()` options take precedence where they overlap.
 */
export interface WeightedRateLimiterOptions {
  redis: RedisConnectionOptions;

  /**
   * Redis key prefix — prevents collisions with other keys in the same instance.
   * @default 'wrl'
   */
  keyPrefix?: string;

  /**
   * What to do when Redis is unreachable.
   * `true` = let requests through; `false` = return 429.
   * @default false
   */
  failOpen?: boolean;

  /**
   * Set `X-RateLimit-*` headers on every response.
   * @default true
   */
  setHeaders?: boolean;

  /**
   * Custom message in the 429 response body.
   * Accepts a static string or a context resolver for dynamic messages.
   * @default 'Too Many Requests'
   */
  errorMessage?: string | ContextResolver<string>;

  /**
   * Observability hooks — called on every evaluated request.
   * Defaults to a no-op. Provide your own to integrate Prometheus, OTel, etc.
   */
  metrics?: RateLimitMetrics;
}

export interface WeightedRateLimiterOptionsFactory {
  createWeightedRateLimiterOptions():
    WeightedRateLimiterOptions | Promise<WeightedRateLimiterOptions>;
}

export interface WeightedRateLimiterAsyncOptions {
  /**
   * Modules to import that provide the dependencies needed by `useFactory` or `useClass`.
   * @example [ConfigModule]
   */
  imports?: Array<DynamicModule | Promise<DynamicModule> | Type<unknown> | ForwardReference>;
  /**
   * Injection tokens to pass as arguments to `useFactory`.
   * @example [ConfigService]
   */
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory?: (
    ...args: Array<unknown>
  ) => WeightedRateLimiterOptions | Promise<WeightedRateLimiterOptions>;
  /** Instantiates the given class and calls `createWeightedRateLimiterOptions()` on it. */
  useClass?: Type<WeightedRateLimiterOptionsFactory>;
  /** Re-uses an already-registered provider as the options factory. */
  useExisting?: Type<WeightedRateLimiterOptionsFactory>;
}
