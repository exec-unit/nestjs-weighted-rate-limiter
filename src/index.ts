/**
 * nestjs-weighted-rate-limiter — Public API
 *
 * Only the symbols listed below are part of the stable public contract.
 * Internal implementations (RedisStore, NoopMetrics) are intentionally excluded.
 */

// Module
export { WeightedRateLimiterModule } from './modules/weighted-rate-limiter.module.js';

// Guard (exported so consumers can register it globally via APP_GUARD)
export { WeightedRateLimiterGuard } from './guards/weighted-rate-limiter.guard.js';

// Service (exported for advanced use: custom guards, testing, manual evaluation)
export { WeightedRateLimiterService } from './services/weighted-rate-limiter.service.js';
export type { PolicyEvaluation } from './services/weighted-rate-limiter.service.js';

// Decorators
export { WeightedLimit } from './decorators/weighted-limit.decorator.js';
export { SkipWeightedLimit } from './decorators/skip-weighted-limit.decorator.js';

// Interfaces
export type { RateLimitPolicy, ContextResolver } from './interfaces/rate-limit-policy.interface.js';
export type { RateLimitResult } from './interfaces/rate-limit-result.interface.js';
export type { IRateLimitStore } from './interfaces/rate-limit-store.interface.js';
export type {
  WeightedRateLimiterOptions,
  WeightedRateLimiterAsyncOptions,
  WeightedRateLimiterOptionsFactory,
  RedisConnectionOptions,
  SingleRedisOptions,
  ClusterRedisOptions,
  ExistingRedisOptions,
} from './interfaces/module-options.interface.js';

// Observability
export type { RateLimitMetrics } from './observability/metrics.js';

// Constants (exported for consumers extending the library: custom guards, custom stores)
export {
  WEIGHTED_LIMIT_METADATA,
  SKIP_WEIGHTED_LIMIT_METADATA,
  REDIS_CLIENT_TOKEN,
  MODULE_OPTIONS_TOKEN,
  RATE_LIMIT_STORE_TOKEN,
} from './constants/metadata.constants.js';

export { RateLimitHeaders } from './constants/headers.constants.js';
