import { Redis } from 'ioredis';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, makeRequest } from '../testing/create-test-app.js';

/**
 * E2E: HTTP-level rate limiting behavior.
 *
 * Verifies the full request lifecycle: headers, 429 responses, weighted costs,
 * and the Retry-After header — all driven through real HTTP against a real Redis
 * instance running in a Testcontainers container.
 */
describe('WeightedRateLimiterModule — rate limiting via HTTP (e2e)', () => {
  let container: StartedRedisContainer;
  let redis: Redis;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) });
  });

  afterAll(async () => {
    await redis.quit();
    await container.stop();
  });

  describe('forRoot() initialization', () => {
    let app: Awaited<ReturnType<typeof createTestApp>>;

    beforeAll(async () => {
      app = await createTestApp(container, 'e2e-init');
    });
    afterAll(async () => {
      await app.close();
    });

    it('bootstraps and serves routes without @WeightedLimit() without rate limiting', async () => {
      const { status } = await makeRequest(app, '/test/unlimited');
      expect(status).toBe(200);
    });
  });

  describe('X-RateLimit headers', () => {
    let app: Awaited<ReturnType<typeof createTestApp>>;

    beforeAll(async () => {
      app = await createTestApp(container, 'e2e-headers');
    });
    afterAll(async () => {
      await app.close();
    });
    beforeEach(async () => {
      await redis.flushdb();
    });

    it('sets correct X-RateLimit-Limit, Remaining, and Reset on allowed requests', async () => {
      // capacity=3 → first request should report limit=3, remaining=2
      const { status, headers } = await makeRequest(app, '/test/limited');

      expect(status).toBe(200);
      expect(headers['x-ratelimit-limit']).toBe('3');
      expect(headers['x-ratelimit-remaining']).toBe('2');
      expect(Number(headers['x-ratelimit-reset'])).toBeGreaterThan(Math.floor(Date.now() / 1_000));
    });

    it('decrements X-RateLimit-Remaining with each sequential request', async () => {
      const first = await makeRequest(app, '/test/limited');
      const second = await makeRequest(app, '/test/limited');

      const rem1 = Number(first.headers['x-ratelimit-remaining']);
      const rem2 = Number(second.headers['x-ratelimit-remaining']);

      expect(rem2).toBe(rem1 - 1);
    });
  });

  describe('429 responses', () => {
    let app: Awaited<ReturnType<typeof createTestApp>>;

    beforeAll(async () => {
      app = await createTestApp(container, 'e2e-429');
    });
    afterAll(async () => {
      await app.close();
    });
    beforeEach(async () => {
      await redis.flushdb();
    });

    it('returns 429 with Retry-After header when capacity is exhausted', async () => {
      // capacity=3: exactly 3 requests are allowed
      await makeRequest(app, '/test/limited');
      await makeRequest(app, '/test/limited');
      await makeRequest(app, '/test/limited');

      const { status, headers } = await makeRequest(app, '/test/limited');

      expect(status).toBe(429);
      // Retry-After must be a positive integer (seconds)
      expect(Number(headers['retry-after'])).toBeGreaterThan(0);
    });

    it('includes retryAfter and statusCode in the 429 response body', async () => {
      await makeRequest(app, '/test/limited');
      await makeRequest(app, '/test/limited');
      await makeRequest(app, '/test/limited');

      const { body } = (await makeRequest(app, '/test/limited')) as {
        body: { statusCode: number; retryAfter: number };
      };

      expect(body.statusCode).toBe(429);
      expect(body.retryAfter).toBeGreaterThan(0);
    });

    it('weighted cost=5 exhausts a bucket of 10 after exactly 2 requests', async () => {
      // 10 / 5 = 2 full requests before denial
      const [first, second, third] = await Promise.all([
        makeRequest(app, '/test/expensive'),
        makeRequest(app, '/test/expensive'),
        makeRequest(app, '/test/expensive'),
      ]);

      // Note: we fire all three concurrently — exactly 2 should pass
      const statuses = [first.status, second.status, third.status].sort();
      expect(statuses).toEqual([200, 200, 429]);
    });
  });
});
