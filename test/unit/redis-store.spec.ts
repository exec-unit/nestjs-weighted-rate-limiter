import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisStore } from '../../src/store/redis.store.js';
import type { WeightedRateLimiterOptions } from '../../src/interfaces/module-options.interface.js';

const defaultOptions: WeightedRateLimiterOptions = {
  redis: { type: 'single', options: {} },
  keyPrefix: 'test',
};

/** Builds a mock ioredis client with controllable responses. */
function createRedisMock(overrides: Record<string, unknown> = {}) {
  return {
    script: vi.fn().mockResolvedValue('abc123sha'),
    evalsha: vi.fn().mockResolvedValue([1, 99, 100, 9_999_999, 0]),
    eval: vi.fn().mockResolvedValue([1, 99, 100, 9_999_999, 0]),
    quit: vi.fn().mockResolvedValue('OK'),
    ...overrides,
  };
}

function buildStore(
  redisMock: ReturnType<typeof createRedisMock>,
  options = defaultOptions,
): RedisStore {
  const store = new RedisStore(redisMock as never, options);
  return store;
}

describe('RedisStore', () => {
  describe('onModuleInit()', () => {
    it('preloads the Lua script via SCRIPT LOAD and logs the SHA', async () => {
      const redis = createRedisMock();
      const store = buildStore(redis);

      await store.onModuleInit();

      expect(redis.script).toHaveBeenCalledWith('LOAD', expect.any(String));
    });

    it('logs a warning and continues when SCRIPT LOAD fails', async () => {
      const redis = createRedisMock({
        script: vi.fn().mockRejectedValue(new Error('READONLY')),
      });
      const store = buildStore(redis);

      // Must not throw — store gracefully degrades to EVAL fallback
      await expect(store.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('consume()', () => {
    let redis: ReturnType<typeof createRedisMock>;
    let store: RedisStore;

    beforeEach(async () => {
      redis = createRedisMock();
      store = buildStore(redis);
      await store.onModuleInit();
    });

    it('uses EVALSHA after successful script load', async () => {
      await store.consume('user:1', 100, 10, 1);

      expect(redis.evalsha).toHaveBeenCalledOnce();
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('namespaces the key with keyPrefix', async () => {
      await store.consume('user:1', 100, 10, 1);

      const [, , key] = redis.evalsha.mock.calls[0] as [string, number, string];
      expect(key).toBe('test:user:1');
    });

    it('uses default prefix "wrl" when keyPrefix is not set', async () => {
      const noPrefix = buildStore(redis, {
        redis: { type: 'single', options: {} },
      });
      await noPrefix.onModuleInit();
      await noPrefix.consume('user:1', 100, 10, 1);

      const [, , key] = redis.evalsha.mock.calls[0] as [string, number, string];
      expect(key).toBe('wrl:user:1');
    });

    it('retries with EVALSHA (not EVAL) after NOSCRIPT error', async () => {
      redis.evalsha
        .mockRejectedValueOnce(new Error('NOSCRIPT No matching script'))
        .mockResolvedValueOnce([1, 99, 100, 9_999_999, 0]);

      await store.consume('user:1', 100, 10, 1);

      // Should have reloaded the script and retried with EVALSHA
      expect(redis.script).toHaveBeenCalledTimes(2); // init + reload
      expect(redis.evalsha).toHaveBeenCalledTimes(2); // fail + retry
      expect(redis.eval).not.toHaveBeenCalled();
    });

    it('falls back to EVAL when initial script load failed', async () => {
      const failedLoadRedis = createRedisMock({
        script: vi.fn().mockRejectedValue(new Error('READONLY')),
      });
      const degradedStore = buildStore(failedLoadRedis);
      await degradedStore.onModuleInit(); // SCRIPT LOAD fails silently

      await degradedStore.consume('user:1', 100, 10, 1);

      expect(failedLoadRedis.eval).toHaveBeenCalledOnce();
      expect(failedLoadRedis.evalsha).not.toHaveBeenCalled();
    });

    it('caps TTL at MAX_TTL_SECONDS (86_400) for slow-refill policies', async () => {
      // capacity=100_000, refillRate=0.1 → raw TTL = 2_000_000s (23 days!)
      await store.consume('user:1', 100_000, 0.1, 1);

      const argv = redis.evalsha.mock.calls[0] as [string, number, string, ...string[]];
      const ttl = parseInt(argv[argv.length - 1] as string, 10);
      expect(ttl).toBe(86_400);
    });

    it('does not apply TTL cap for normal policies', async () => {
      // capacity=100, refillRate=10 → TTL = 20s, well under 86_400
      await store.consume('user:1', 100, 10, 1);

      const argv = redis.evalsha.mock.calls[0] as [string, number, string, ...string[]];
      const ttl = parseInt(argv[argv.length - 1] as string, 10);
      expect(ttl).toBe(20);
    });

    it('deserializes allowed response correctly', async () => {
      redis.evalsha.mockResolvedValueOnce([1, 42, 100, 1_700_000_000, 0]);

      const result = await store.consume('user:1', 100, 10, 1);

      expect(result).toEqual({
        allowed: true,
        remaining: 42,
        limit: 100,
        resetAt: 1_700_000_000,
        retryAfter: 0,
      });
    });

    it('deserializes denied response correctly', async () => {
      redis.evalsha.mockResolvedValueOnce([0, 3, 100, 1_700_000_000, 7]);

      const result = await store.consume('user:1', 100, 10, 1);

      expect(result).toEqual({
        allowed: false,
        remaining: 3,
        limit: 100,
        resetAt: 1_700_000_000,
        retryAfter: 7,
      });
    });

    it('propagates non-NOSCRIPT errors from EVALSHA', async () => {
      redis.evalsha.mockRejectedValueOnce(new Error('LOADING Redis is loading'));

      await expect(store.consume('user:1', 100, 10, 1)).rejects.toThrow('LOADING');
    });
  });
});
