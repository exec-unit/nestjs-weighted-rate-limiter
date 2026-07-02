import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, it, expect, vi } from 'vitest';
import { WeightedRateLimiterGuard } from '../../src/guards/weighted-rate-limiter.guard.js';
import type { WeightedRateLimiterService } from '../../src/services/weighted-rate-limiter.service.js';
import { createMockExecutionContext } from '../testing/mock-execution-context.js';
import type { WeightedRateLimiterOptions } from '../../src/interfaces/module-options.interface.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface BuildFailingGuardOptions {
  moduleOptions?: Partial<WeightedRateLimiterOptions>;
  /**
   * When set, `resolvePolicy` returns a policy with this failOpen value,
   * simulating a per-route @WeightedLimit({ failOpen }) decorator.
   */
  perRouteFailOpen?: boolean;
  /** Error thrown by the store/service — defaults to a connectivity error. */
  storeError?: Error;
}

function buildFailingGuard({
  moduleOptions = {},
  perRouteFailOpen,
  storeError = new Error('Redis connection refused'),
}: BuildFailingGuardOptions = {}): {
  guard: WeightedRateLimiterGuard;
  serviceMock: WeightedRateLimiterService;
} {
  const serviceMock = {
    evaluate: vi.fn().mockRejectedValue(storeError),
    resolvePolicy: vi
      .fn()
      .mockReturnValue(perRouteFailOpen !== undefined ? { failOpen: perRouteFailOpen } : null),
    reportError: vi.fn(),
  } as unknown as WeightedRateLimiterService;

  const fullOptions: WeightedRateLimiterOptions = {
    redis: { type: 'single', options: {} },
    ...moduleOptions,
  };

  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

  return { guard: new WeightedRateLimiterGuard(serviceMock, fullOptions, reflector), serviceMock };
}

// ---------------------------------------------------------------------------
// Tests: fail-open / fail-closed behaviour
// ---------------------------------------------------------------------------

describe('WeightedRateLimiterGuard — fail-open / fail-closed', () => {
  describe('default behaviour (no failOpen configured)', () => {
    it('is fail-closed: throws 429 when the store is unavailable', async () => {
      const { guard } = buildFailingGuard();
      const { ctx } = createMockExecutionContext();

      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });
  });

  describe('module-level failOpen option', () => {
    it('allows the request when failOpen: true and store throws', async () => {
      const { guard } = buildFailingGuard({ moduleOptions: { failOpen: true } });
      const { ctx } = createMockExecutionContext();

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('denies the request when failOpen: false and store throws', async () => {
      const { guard } = buildFailingGuard({ moduleOptions: { failOpen: false } });
      const { ctx } = createMockExecutionContext();

      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });
  });

  describe('per-route failOpen override', () => {
    it('per-route failOpen: true overrides global failOpen: false', async () => {
      const { guard } = buildFailingGuard({
        moduleOptions: { failOpen: false },
        perRouteFailOpen: true,
      });
      const { ctx } = createMockExecutionContext();

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it('per-route failOpen: false overrides global failOpen: true', async () => {
      const { guard } = buildFailingGuard({
        moduleOptions: { failOpen: true },
        perRouteFailOpen: false,
      });
      const { ctx } = createMockExecutionContext();

      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });
  });

  describe('observability', () => {
    it('calls reportError with handler name and original error on store failure', async () => {
      const storeError = new Error('ECONNREFUSED 127.0.0.1:6379');
      const { guard, serviceMock } = buildFailingGuard({ storeError });

      function myRouteHandler() {
        /* stub */
      }
      const { ctx } = createMockExecutionContext(myRouteHandler);

      await guard.canActivate(ctx).catch(() => {
        /* expected 429 */
      });

      expect(serviceMock.reportError).toHaveBeenCalledOnce();
      expect(serviceMock.reportError).toHaveBeenCalledWith('myRouteHandler', storeError);
    });
  });

  describe('HttpException passthrough (no double-wrapping)', () => {
    it('re-throws HttpExceptions directly without wrapping in another HttpException', async () => {
      // A 429 thrown from inside evaluate() (e.g. from a nested guard or middleware)
      // must propagate unchanged — not be wrapped in a second 429.
      const originalException = new HttpException({ message: 'Rate limit exceeded' }, 429);

      const serviceMock = {
        evaluate: vi.fn().mockRejectedValue(originalException),
        resolvePolicy: vi.fn().mockReturnValue(null),
        reportError: vi.fn(),
      } as unknown as WeightedRateLimiterService;

      const reflector = new Reflector();
      vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

      const guard = new WeightedRateLimiterGuard(
        serviceMock,
        { redis: { type: 'single', options: {} }, failOpen: true },
        reflector,
      );
      const { ctx } = createMockExecutionContext();

      const err = await guard.canActivate(ctx).catch((e: unknown) => e);
      // Must be the exact same reference — no wrapping
      expect(err).toBe(originalException);
    });
  });
});
