import { Redis } from 'ioredis';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { WeightedRateLimiterModule } from '../../src/modules/weighted-rate-limiter.module.js';
import { WeightedRateLimiterGuard } from '../../src/guards/weighted-rate-limiter.guard.js';
import { createTestApp, makeRequest, TestController } from '../testing/create-test-app.js';

/**
 * E2E: Application lifecycle and Redis connection management.
 *
 * Validates that the library correctly implements NestJS lifecycle hooks:
 * - `OnApplicationShutdown` closes only the connections it created.
 * - Externally-provided Redis clients (type: 'existing') are never closed.
 *
 * This suite intentionally does NOT reuse the shared `createTestApp` helper for the
 * "existing client" test to explicitly control the Redis client lifetime.
 */
describe('WeightedRateLimiterModule — lifecycle (e2e)', () => {
  let container: StartedRedisContainer;

  beforeAll(async () => {
    container = await new RedisContainer('redis:7-alpine').start();
  });

  afterAll(async () => {
    await container.stop();
  });

  it('closes the managed Redis connection cleanly on app.close()', async () => {
    const app = await createTestApp(container, 'e2e-lifecycle-managed');

    const { status } = await makeRequest(app, '/test/unlimited');
    expect(status).toBe(200);

    // OnApplicationShutdown hook must complete without throwing or hanging
    await expect(app.close()).resolves.toBeUndefined();
  });

  it('does NOT close an externally-provided Redis client on app.close()', async () => {
    const externalRedis = new Redis({
      host: container.getHost(),
      port: container.getMappedPort(6379),
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        WeightedRateLimiterModule.forRoot({
          redis: { type: 'existing', client: externalRedis },
          keyPrefix: 'e2e-lifecycle-external',
        }),
      ],
      controllers: [TestController],
      providers: [{ provide: APP_GUARD, useClass: WeightedRateLimiterGuard }],
    }).compile();

    const app = moduleRef.createNestApplication();
    await app.listen(0);
    await app.close();

    // If the module mistakenly closed the external client, PING would reject
    await expect(externalRedis.ping()).resolves.toBe('PONG');

    await externalRedis.quit();
  });
});
