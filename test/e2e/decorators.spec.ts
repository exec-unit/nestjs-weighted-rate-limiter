import { Redis } from 'ioredis';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createTestApp, makeRequest } from '../testing/create-test-app.js';

/**
 * E2E: @SkipWeightedLimit() and @WeightedLimit() decorator interactions.
 *
 * These tests exist at E2E level because the interaction between:
 *   - NestJS Reflector metadata resolution
 *   - class-level vs. method-level decorator precedence
 *   - the global APP_GUARD
 *
 * …cannot be fully validated in unit tests without mocking so much of NestJS
 * internals that the test loses its value.
 */
describe('WeightedRateLimiterModule — decorator interactions (e2e)', () => {
  let container: StartedRedisContainer;
  let redis: Redis;
  let app: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
    redis = new Redis({ host: container.getHost(), port: container.getMappedPort(6379) });
    app = await createTestApp(container, 'e2e-decorators');
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await container.stop();
  });

  // Flush Redis between tests to ensure bucket state isolation
  beforeEach(async () => {
    await redis.flushdb();
  });

  describe('@SkipWeightedLimit() on a method', () => {
    it('bypasses the global guard — route is always allowed regardless of bucket state', async () => {
      // First: confirm the guard IS active by exhausting a sibling route
      await makeRequest(app, '/test/limited');
      await makeRequest(app, '/test/limited');
      await makeRequest(app, '/test/limited');
      expect((await makeRequest(app, '/test/limited')).status).toBe(429);

      // Now: the skipped route must still respond 200 even though the guard is enforcing elsewhere
      const { status } = await makeRequest(app, '/test/skipped');
      expect(status).toBe(200);
    });

    it('does not set X-RateLimit-* headers (no bucket interaction)', async () => {
      const { headers } = await makeRequest(app, '/test/skipped');

      expect(headers['x-ratelimit-limit']).toBeUndefined();
      expect(headers['x-ratelimit-remaining']).toBeUndefined();
      expect(headers['x-ratelimit-reset']).toBeUndefined();
    });
  });

  describe('@SkipWeightedLimit() overriding class-level @WeightedLimit()', () => {
    it('exempt method is allowed even after class-level bucket is exhausted', async () => {
      // Exhaust the class-level bucket (capacity=2)
      await makeRequest(app, '/api/a');
      await makeRequest(app, '/api/a');
      const denied = await makeRequest(app, '/api/a');
      expect(denied.status).toBe(429); // confirms class policy is active

      // The exempt method on the same controller must pass
      const exempt = await makeRequest(app, '/api/exempt');
      expect(exempt.status).toBe(200);
    });

    it('non-exempt methods on the same controller remain rate-limited', async () => {
      await makeRequest(app, '/api/a');
      await makeRequest(app, '/api/a');

      const { status } = await makeRequest(app, '/api/a');
      expect(status).toBe(429);
    });
  });

  describe('forRootAsync() registration', () => {
    it('initializes correctly via useFactory', async () => {
      const { Controller, Get } = await import('@nestjs/common');
      const { APP_GUARD } = await import('@nestjs/core');
      const { Test } = await import('@nestjs/testing');
      const { WeightedRateLimiterModule } =
        await import('../../src/modules/weighted-rate-limiter.module.js');
      const { WeightedRateLimiterGuard } =
        await import('../../src/guards/weighted-rate-limiter.guard.js');

      @Controller('probe')
      class ProbeController {
        @Get()
        ping(): { ok: boolean } {
          return { ok: true };
        }
      }

      const moduleRef = await Test.createTestingModule({
        imports: [
          WeightedRateLimiterModule.forRootAsync({
            useFactory: () => ({
              redis: {
                type: 'single' as const,
                options: { host: container.getHost(), port: container.getMappedPort(6379) },
              },
              keyPrefix: 'e2e-async',
            }),
          }),
        ],
        controllers: [ProbeController],
        providers: [{ provide: APP_GUARD, useClass: WeightedRateLimiterGuard }],
      }).compile();

      const asyncApp = moduleRef.createNestApplication();
      await asyncApp.listen(0);

      const { status } = await makeRequest(asyncApp, '/probe');
      expect(status).toBe(200);

      await asyncApp.close();
    });
  });
});
