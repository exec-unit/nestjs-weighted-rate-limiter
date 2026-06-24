/**
 * Observability hooks invoked on every rate-limited request.
 *
 * Implement this to integrate with your metrics backend (Prometheus, OTel, Datadog…).
 * Pass the implementation via `WeightedRateLimiterOptions.metrics`.
 *
 * @example
 * Prometheus integration:
 * ```typescript
 *  export class PrometheusMetrics implements RateLimitMetrics {
 *    private readonly allowed = new Counter({ name: 'rl_allowed_total', help: '' });
 *    private readonly rejected = new Counter({ name: 'rl_rejected_total', help: '' });
 *
 *    onAllowed(key, cost, remaining) { this.allowed.inc({ key }); }
 *    onRejected(key, cost, retryAfter) { this.rejected.inc({ key }); }
 *    onError(key, error) { ... }
 *  }
 * ```
 */
export interface RateLimitMetrics {
  onAllowed(key: string, cost: number, remaining: number): void;
  onRejected(key: string, cost: number, retryAfter: number): void;
  /** Called when the store throws — before fail-open/fail-closed is applied. */
  onError(key: string, error: Error): void;
}

/**
 * No-op default — zero runtime overhead.
 * V8 will inline and eliminate these empty methods.
 */
export class NoopMetrics implements RateLimitMetrics {
  onAllowed(_key: string, _cost: number, _remaining: number): void {}
  onRejected(_key: string, _cost: number, _retryAfter: number): void {}
  onError(_key: string, _error: Error): void {}
}
