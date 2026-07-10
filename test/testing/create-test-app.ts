import * as http from 'http';
import type { AddressInfo } from 'net';
import type { INestApplication } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { StartedRedisContainer } from '@testcontainers/redis';
import { WeightedRateLimiterModule } from '../../src/modules/weighted-rate-limiter.module.js';
import { WeightedRateLimiterGuard } from '../../src/guards/weighted-rate-limiter.guard.js';
import { WeightedLimit } from '../../src/decorators/weighted-limit.decorator.js';
import { SkipWeightedLimit } from '../../src/decorators/skip-weighted-limit.decorator.js';

// ---------------------------------------------------------------------------
// Fixture controllers — shared across all E2E suites
// ---------------------------------------------------------------------------

/**
 * Primary fixture controller covering the main use cases:
 * - `unlimited`: no decorator — guard passes through without any store call
 * - `limited`:   capacity=3, cost=1 — exhausted after 3 requests
 * - `expensive`: capacity=10, cost=5 — exhausted after 2 requests
 * - `skipped`:   explicitly opted out via @SkipWeightedLimit()
 */
@Controller('test')
export class TestController {
  @Get('unlimited')
  unlimited(): { ok: boolean } {
    return { ok: true };
  }

  @Get('limited')
  @WeightedLimit({ capacity: 3, refillRate: 1, key: () => 'e2e-limited' })
  limited(): { ok: boolean } {
    return { ok: true };
  }

  @Get('expensive')
  @WeightedLimit({ capacity: 10, refillRate: 1, key: () => 'e2e-expensive', cost: 5 })
  expensive(): { ok: boolean } {
    return { ok: true };
  }

  @Get('skipped')
  @SkipWeightedLimit()
  skipped(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * Fixture controller with a class-level @WeightedLimit policy.
 * Used to verify that method-level @SkipWeightedLimit() overrides it.
 */
@Controller('api')
@WeightedLimit({ capacity: 2, refillRate: 0.1, key: () => 'e2e-class-level' })
export class ClassLevelController {
  @Get('a')
  a(): { ok: boolean } {
    return { ok: true };
  }

  @Get('exempt')
  @SkipWeightedLimit()
  exempt(): { ok: boolean } {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// HTTP utility
// ---------------------------------------------------------------------------

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Fires a GET request to the NestJS test app.
 *
 * Uses the native `http` module instead of supertest to avoid an extra
 * devDependency while keeping the implementation transparent.
 */
export async function makeRequest(app: INestApplication, path: string): Promise<HttpResult> {
  const server = app.getHttpAdapter().getHttpServer() as http.Server;
  const { port } = server.address() as AddressInfo;

  return new Promise<HttpResult>((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            body: JSON.parse(raw || 'null') as unknown,
          });
        });
      })
      .on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Compiles and starts a NestJS test application backed by a Testcontainers Redis instance.
 *
 * Each E2E suite should use a unique `keyPrefix` so that bucket state never
 * bleeds between suites sharing the same container. Port 0 lets the OS pick a
 * free port, preventing conflicts when suites run in parallel.
 */
export async function createTestApp(
  container: StartedRedisContainer,
  keyPrefix: string,
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      WeightedRateLimiterModule.forRoot({
        redis: {
          type: 'single',
          options: { host: container.getHost(), port: container.getMappedPort(6379) },
        },
        keyPrefix,
        failOpen: false,
        setHeaders: true,
      }),
    ],
    controllers: [TestController, ClassLevelController],
    providers: [{ provide: APP_GUARD, useClass: WeightedRateLimiterGuard }],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.listen(0);
  return app;
}
