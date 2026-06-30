import { Reflector } from '@nestjs/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WeightedRateLimiterService } from '../../src/services/weighted-rate-limiter.service.js';
import { createMockExecutionContext } from '../testing/mock-execution-context.js';
import { InMemoryRateLimitStore } from '../testing/in-memory-rate-limit-store.js';
import type { RateLimitPolicy } from '../../src/interfaces/rate-limit-policy.interface.js';
import type { WeightedRateLimiterOptions } from '../../src/interfaces/module-options.interface.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const BASE_OPTIONS: WeightedRateLimiterOptions = {
  redis: { type: 'single', options: { host: 'localhost' } },
};

function buildPolicy(overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy {
  return { capacity: 100, refillRate: 10, key: () => 'test-key', ...overrides };
}

function createService(
  policy: RateLimitPolicy,
  store: InMemoryRateLimitStore,
  options: WeightedRateLimiterOptions = BASE_OPTIONS,
): WeightedRateLimiterService {
  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(policy);
  return new WeightedRateLimiterService(reflector, store, options);
}

// ---------------------------------------------------------------------------
// Tests: parameter validation
//
// Rationale: the Lua token bucket script assumes well-formed inputs.
// Validation happens synchronously in TypeScript before the store is called,
// so misconfigured policies fail fast with a descriptive error instead of
// causing subtle Lua arithmetic bugs (e.g. division by zero for refillRate=0).
// ---------------------------------------------------------------------------

describe('WeightedRateLimiterService — parameter validation', () => {
  let store: InMemoryRateLimitStore;

  beforeEach(() => {
    store = new InMemoryRateLimitStore();
  });

  describe('invalid inputs that must throw', () => {
    it.each([
      {
        label: 'capacity = 0',
        policy: buildPolicy({ capacity: 0 }),
        expectedMessage: 'capacity must be > 0',
      },
      {
        label: 'capacity < 0',
        policy: buildPolicy({ capacity: -10 }),
        expectedMessage: 'capacity must be > 0',
      },
      {
        label: 'refillRate < 0',
        policy: buildPolicy({ refillRate: -1 }),
        expectedMessage: 'refillRate must be >= 0',
      },
      {
        label: 'cost < 0',
        policy: buildPolicy({ cost: -5 }),
        expectedMessage: 'cost must be >= 0',
      },
      {
        label: 'key resolves to empty string',
        policy: buildPolicy({ key: () => '' }),
        expectedMessage: 'key must be a non-empty string',
      },
    ])('throws "$expectedMessage" for $label', async ({ policy, expectedMessage }) => {
      const service = createService(policy, store);
      const { ctx } = createMockExecutionContext();

      await expect(service.evaluate(ctx)).rejects.toThrow(expectedMessage);
    });
  });

  describe('valid edge-case inputs that must NOT throw', () => {
    it.each([
      {
        label: 'refillRate = 0 (fixed capacity, no refill)',
        policy: buildPolicy({ capacity: 5, refillRate: 0, cost: 1 }),
      },
      {
        label: 'cost = 0 (read-only peek — does not consume tokens)',
        policy: buildPolicy({ cost: 0 }),
      },
    ])('resolves successfully for $label', async ({ policy }) => {
      const service = createService(policy, store);
      const { ctx } = createMockExecutionContext();

      await expect(service.evaluate(ctx)).resolves.not.toBeNull();
    });
  });
});
