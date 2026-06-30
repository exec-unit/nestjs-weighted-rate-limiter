import { Reflector } from '@nestjs/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WeightedRateLimiterService } from '../../src/services/weighted-rate-limiter.service.js';
import { createMockExecutionContext } from '../testing/mock-execution-context.js';
import { InMemoryRateLimitStore } from '../testing/in-memory-rate-limit-store.js';
import type { RateLimitPolicy } from '../../src/interfaces/rate-limit-policy.interface.js';
import type { WeightedRateLimiterOptions } from '../../src/interfaces/module-options.interface.js';
import type { RateLimitMetrics } from '../../src/observability/metrics.js';

// ---------------------------------------------------------------------------
// Fixtures & factories
// ---------------------------------------------------------------------------

const BASE_OPTIONS: WeightedRateLimiterOptions = {
  redis: { type: 'single', options: { host: 'localhost' } },
};

function buildPolicy(overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy {
  return { capacity: 100, refillRate: 10, key: () => 'test-key', ...overrides };
}

function createService(
  policy: RateLimitPolicy | undefined,
  store: InMemoryRateLimitStore,
  options: WeightedRateLimiterOptions = BASE_OPTIONS,
): WeightedRateLimiterService {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(policy);
  return new WeightedRateLimiterService(reflector, store, options);
}

// ---------------------------------------------------------------------------
// Tests: evaluate()
// ---------------------------------------------------------------------------

describe('WeightedRateLimiterService — evaluate()', () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  describe('no @WeightedLimit() decorator', () => {
    it('returns null — guard should pass through', async () => {
      const service = createService(undefined, store);
      const { ctx } = createMockExecutionContext();

      await expect(service.evaluate(ctx)).resolves.toBeNull();
    });
  });

  describe('policy resolution', () => {
    it('passes static key, capacity, refillRate, and cost to the store unchanged', async () => {
      const consumeSpy = vi.spyOn(store, 'consume');
      const service = createService(buildPolicy({ cost: 5 }), store);
      const { ctx } = createMockExecutionContext();

      await service.evaluate(ctx);

      expect(consumeSpy).toHaveBeenCalledExactlyOnceWith('test-key', 100, 10, 5);
    });

    it('defaults cost to 1 when omitted from the policy', async () => {
      const consumeSpy = vi.spyOn(store, 'consume');
      const service = createService(buildPolicy(), store);
      const { ctx } = createMockExecutionContext();

      await service.evaluate(ctx);

      expect(consumeSpy).toHaveBeenCalledExactlyOnceWith('test-key', 100, 10, 1);
    });

    it('resolves synchronous ContextResolver functions for all four policy fields', async () => {
      const consumeSpy = vi.spyOn(store, 'consume');
      const policy: RateLimitPolicy = {
        capacity: () => 200,
        refillRate: () => 20,
        cost: () => 3,
        key: () => 'dynamic-key',
      };
      const service = createService(policy, store);
      const { ctx } = createMockExecutionContext();

      await service.evaluate(ctx);

      expect(consumeSpy).toHaveBeenCalledExactlyOnceWith('dynamic-key', 200, 20, 3);
    });

    it('awaits async ContextResolver functions before calling the store', async () => {
      const consumeSpy = vi.spyOn(store, 'consume');
      const policy: RateLimitPolicy = {
        capacity: 100,
        refillRate: 10,
        key: () => Promise.resolve('async-key'),
        cost: () => Promise.resolve(7),
      };
      const service = createService(policy, store);
      const { ctx } = createMockExecutionContext();

      await service.evaluate(ctx);

      expect(consumeSpy).toHaveBeenCalledExactlyOnceWith('async-key', 100, 10, 7);
    });
  });

  describe('failOpen resolution', () => {
    it('returns per-route failOpen from the policy', async () => {
      const service = createService(buildPolicy({ failOpen: true }), store);
      const { ctx } = createMockExecutionContext();

      const result = await service.evaluate(ctx);

      expect(result?.failOpen).toBe(true);
    });

    it('falls back to module-level failOpen when not set on the policy', async () => {
      const service = createService(buildPolicy(), store, { ...BASE_OPTIONS, failOpen: true });
      const { ctx } = createMockExecutionContext();

      const result = await service.evaluate(ctx);

      expect(result?.failOpen).toBe(true);
    });

    it('defaults to false when neither policy nor module sets failOpen', async () => {
      const service = createService(buildPolicy(), store, BASE_OPTIONS);
      const { ctx } = createMockExecutionContext();

      const result = await service.evaluate(ctx);

      expect(result?.failOpen).toBe(false);
    });
  });

  describe('observability (metrics hooks)', () => {
    function buildMetrics(): {
      mock: RateLimitMetrics;
      onAllowed: ReturnType<typeof vi.fn>;
      onRejected: ReturnType<typeof vi.fn>;
      onError: ReturnType<typeof vi.fn>;
    } {
      const onAllowed = vi.fn();
      const onRejected = vi.fn();
      const onError = vi.fn();
      return { mock: { onAllowed, onRejected, onError }, onAllowed, onRejected, onError };
    }

    it('calls metrics.onAllowed with key, cost, and remaining on allowed requests', async () => {
      const { mock, onAllowed } = buildMetrics();
      const service = createService(buildPolicy({ cost: 3 }), store, {
        ...BASE_OPTIONS,
        metrics: mock,
      });
      const { ctx } = createMockExecutionContext();

      await service.evaluate(ctx);

      expect(onAllowed).toHaveBeenCalledExactlyOnceWith('test-key', 3, expect.any(Number));
    });

    it('calls metrics.onRejected with key, cost, and retryAfter when request is denied', async () => {
      const { mock, onRejected } = buildMetrics();
      // cost > capacity → always denied on first request
      const service = createService(buildPolicy({ capacity: 1, cost: 999 }), store, {
        ...BASE_OPTIONS,
        metrics: mock,
      });
      const { ctx } = createMockExecutionContext();

      await service.evaluate(ctx);

      expect(onRejected).toHaveBeenCalledExactlyOnceWith('test-key', 999, expect.any(Number));
    });
  });

  describe('resolvePolicy()', () => {
    it('returns null when the route has no metadata', () => {
      const service = createService(undefined, store);
      const { ctx } = createMockExecutionContext();

      expect(service.resolvePolicy(ctx)).toBeNull();
    });

    it('returns the exact policy object from the reflector', () => {
      const policy = buildPolicy();
      const service = createService(policy, store);
      const { ctx } = createMockExecutionContext();

      expect(service.resolvePolicy(ctx)).toBe(policy);
    });
  });
});
