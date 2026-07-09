import { Redis } from 'ioredis';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { RedisStore } from '../../src/store/redis.store.js';
import type { WeightedRateLimiterOptions } from '../../src/interfaces/module-options.interface.js';

/**
 * Integration tests — spin up a real Redis container via Testcontainers.
 * Docker must be running. Images are cached after the first pull.
 *
 * Run with: pnpm test:integration
 */
describe('RedisStore (integration)', () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let store: RedisStore;

  const options: WeightedRateLimiterOptions = {
    redis: { type: 'single', options: {} },
    keyPrefix: 'int-test',
  };

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();

    redis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });

    store = new RedisStore(redis, options);
    await store.onModuleInit();
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
  });

  beforeEach(async () => {
    // Clean state between tests
    await redis.flushdb();
    // Re-init to reload the script SHA after flush (SCRIPT FLUSH is NOT called, but this
    // ensures a clean bucket state for each test)
  });

  describe('Token Bucket algorithm correctness', () => {
    it('allows a request within capacity', async () => {
      const result = await store.consume('user:1', 10, 1, 1);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.limit).toBe(10);
    });

    it('deducts the exact cost from the bucket', async () => {
      const result = await store.consume('user:1', 100, 10, 7);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(93);
    });

    it('denies a request when cost exceeds available tokens', async () => {
      // Exhaust the bucket first
      await store.consume('user:1', 5, 0.1, 5);

      const result = await store.consume('user:1', 5, 0.1, 1);

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('returns a positive retryAfter proportional to the deficit', async () => {
      // Bucket capacity=10, refillRate=1/s. Consume all 10 then try to get 5 more.
      await store.consume('user:1', 10, 1, 10);
      const result = await store.consume('user:1', 10, 1, 5);

      expect(result.allowed).toBe(false);
      // Need 5 more tokens at 1/s → 5 seconds (Lua uses ceil)
      expect(result.retryAfter).toBe(5);
    });

    it('different keys maintain independent buckets', async () => {
      await store.consume('user:1', 5, 1, 5); // exhaust user:1

      const result = await store.consume('user:2', 5, 1, 1);

      expect(result.allowed).toBe(true);
    });

    it('resetAt is approximately now + (deficit / refillRate) seconds', async () => {
      // Consume 5 of 10 tokens at refillRate=1. Remaining=5, needs 5 more to be full.
      // resetAt should be ~5 seconds from now.
      const before = Math.floor(Date.now() / 1_000);
      const result = await store.consume('user:1', 10, 1, 5);
      const after = Math.ceil(Date.now() / 1_000);

      // secondsToFull = ceil((10 - 5) / 1) = 5
      expect(result.resetAt).toBeGreaterThanOrEqual(before + 4);
      expect(result.resetAt).toBeLessThanOrEqual(after + 6);
    });
  });

  describe('Atomicity (Lua script race condition prevention)', () => {
    it('concurrent requests do not over-consume tokens', async () => {
      const capacity = 5;
      // Fire 10 concurrent requests with cost=1 each against a bucket of 5
      const results = await Promise.all(
        Array.from({ length: 10 }, () => store.consume('concurrent:1', capacity, 100, 1)),
      );

      const allowed = results.filter((r) => r.allowed).length;
      const denied = results.filter((r) => !r.allowed).length;

      // Exactly capacity requests should be allowed — atomicity guarantees this
      expect(allowed).toBe(capacity);
      expect(denied).toBe(10 - capacity);
    });

    it('remaining count never goes negative under concurrent load', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => store.consume('concurrent:2', 5, 100, 1)),
      );

      for (const result of results) {
        expect(result.remaining).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('EVALSHA / EVAL fallback', () => {
    it('reloads the script and retries with EVALSHA on NOSCRIPT', async () => {
      // Flush all scripts from Redis to simulate a restart
      await redis.call('SCRIPT', 'FLUSH');

      // The next call should detect NOSCRIPT, reload, and succeed
      const result = await store.consume('user:1', 100, 10, 1);

      expect(result.allowed).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('cost=0 (peek) returns current state without modifying the bucket', async () => {
      // Consume 3 tokens first to set a known state
      await store.consume('peek:1', 10, 0.001, 3);

      // Peek: cost=0 should not change remaining count
      const peekResult = await store.consume('peek:1', 10, 0.001, 0);
      expect(peekResult.allowed).toBe(true);

      // A real consume after peek should see the same remaining as before peek
      const realResult = await store.consume('peek:1', 10, 0.001, 1);
      expect(realResult.allowed).toBe(true);
      // remaining after real consume ≈ 7 - 1 = 6 (within 1 token tolerance for timing)
      expect(realResult.remaining).toBeGreaterThanOrEqual(5);
    });

    it('refillRate=0 (fixed capacity) never replenishes and returns retryAfter=0', async () => {
      // Exhaust the fixed bucket
      await store.consume('fixed:1', 3, 0, 3);

      const result = await store.consume('fixed:1', 3, 0, 1);

      expect(result.allowed).toBe(false);
      // retryAfter=0 signals "no retry possible — bucket will never refill"
      expect(result.retryAfter).toBe(0);
    });
  });

  describe('Key TTL', () => {
    it('sets a TTL on the bucket key', async () => {
      await store.consume('ttl:1', 10, 1, 1);

      const ttl = await redis.ttl('int-test:ttl:1');

      // TTL should be set (capacity/refillRate * 2 = 20s, capped at 86_400)
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(86_400);
    });

    it('refreshes TTL on every access', async () => {
      await store.consume('ttl:2', 100, 10, 1);
      const ttl1 = await redis.ttl('int-test:ttl:2');

      // Second access should reset the TTL to the same value (not less)
      await store.consume('ttl:2', 100, 10, 1);
      const ttl2 = await redis.ttl('int-test:ttl:2');

      expect(ttl2).toBeGreaterThanOrEqual(ttl1 - 1); // allow 1s tolerance
    });
  });
});
