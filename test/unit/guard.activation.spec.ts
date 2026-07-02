import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, it, expect, vi } from 'vitest';
import { WeightedRateLimiterGuard } from '../../src/guards/weighted-rate-limiter.guard.js';
import type { WeightedRateLimiterService } from '../../src/services/weighted-rate-limiter.service.js';
import { RateLimitHeaders } from '../../src/constants/headers.constants.js';
import { createMockExecutionContext } from '../testing/mock-execution-context.js';
import type { PolicyEvaluation } from '../../src/services/weighted-rate-limiter.service.js';
import type { RateLimitResult } from '../../src/interfaces/rate-limit-result.interface.js';
import type { WeightedRateLimiterOptions } from '../../src/interfaces/module-options.interface.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALLOWED_RESULT: RateLimitResult = {
  allowed: true,
  limit: 100,
  remaining: 50,
  resetAt: 9_999_999,
  retryAfter: 0,
};

const DENIED_RESULT: RateLimitResult = {
  allowed: false,
  limit: 100,
  remaining: 0,
  resetAt: 9_999_999,
  retryAfter: 5,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

interface BuildGuardOptions {
  /** What service.evaluate() returns. `null` simulates a route with no @WeightedLimit(). */
  evaluation: PolicyEvaluation | null;
  /** Module-level options merged with minimal defaults. */
  moduleOptions?: Partial<WeightedRateLimiterOptions>;
  /**
   * Value returned by Reflector for the SKIP_WEIGHTED_LIMIT_METADATA key.
   * `true` simulates @SkipWeightedLimit() on the route.
   */
  skipMetadata?: boolean;
}

function buildGuard({ evaluation, moduleOptions = {}, skipMetadata }: BuildGuardOptions): {
  guard: WeightedRateLimiterGuard;
  serviceMock: WeightedRateLimiterService;
} {
  const serviceMock = {
    evaluate: vi.fn().mockResolvedValue(evaluation),
    resolvePolicy: vi.fn().mockReturnValue(null),
    reportError: vi.fn(),
  } as unknown as WeightedRateLimiterService;

  const fullOptions: WeightedRateLimiterOptions = {
    redis: { type: 'single', options: {} },
    ...moduleOptions,
  };

  const reflector = new Reflector();
  vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(skipMetadata);

  return { guard: new WeightedRateLimiterGuard(serviceMock, fullOptions, reflector), serviceMock };
}

// ---------------------------------------------------------------------------
// Tests: guard activation and HTTP plumbing
// ---------------------------------------------------------------------------

describe('WeightedRateLimiterGuard — activation and HTTP plumbing', () => {
  describe('pass-through conditions', () => {
    it('returns true without touching the store when route has no @WeightedLimit()', async () => {
      const { guard, serviceMock } = buildGuard({ evaluation: null });
      const { ctx, mock } = createMockExecutionContext();

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(serviceMock.evaluate).toHaveBeenCalledOnce(); // service IS called; it returns null
      expect(mock.response.setHeader).not.toHaveBeenCalled();
    });

    it('@SkipWeightedLimit() returns true without calling evaluate()', async () => {
      const { guard, serviceMock } = buildGuard({
        evaluation: { result: ALLOWED_RESULT, failOpen: false },
        skipMetadata: true,
      });
      const { ctx } = createMockExecutionContext();

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      // Fast path exits before evaluate() is ever invoked
      expect(serviceMock.evaluate).not.toHaveBeenCalled();
    });
  });

  describe('allowed requests', () => {
    it('sets X-RateLimit-Limit, Remaining, and Reset headers with correct values', async () => {
      const { guard } = buildGuard({ evaluation: { result: ALLOWED_RESULT, failOpen: false } });
      const { ctx, mock } = createMockExecutionContext();

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(mock.response.setHeader).toHaveBeenCalledWith(RateLimitHeaders.LIMIT, 100);
      expect(mock.response.setHeader).toHaveBeenCalledWith(RateLimitHeaders.REMAINING, 50);
      expect(mock.response.setHeader).toHaveBeenCalledWith(RateLimitHeaders.RESET, 9_999_999);
    });

    it('suppresses all headers when setHeaders: false', async () => {
      const { guard } = buildGuard({
        evaluation: { result: ALLOWED_RESULT, failOpen: false },
        moduleOptions: { setHeaders: false },
      });
      const { ctx, mock } = createMockExecutionContext();

      await guard.canActivate(ctx);
      expect(mock.response.setHeader).not.toHaveBeenCalled();
    });
  });

  describe('denied requests (429)', () => {
    it('throws HttpException with status 429', async () => {
      const { guard } = buildGuard({ evaluation: { result: DENIED_RESULT, failOpen: false } });
      const { ctx } = createMockExecutionContext();

      const err = await guard.canActivate(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    });

    it('sets X-RateLimit headers AND Retry-After on denial', async () => {
      const { guard } = buildGuard({ evaluation: { result: DENIED_RESULT, failOpen: false } });
      const { ctx, mock } = createMockExecutionContext();

      await guard.canActivate(ctx).catch(() => {
        /* expected */
      });
      expect(mock.response.setHeader).toHaveBeenCalledWith(RateLimitHeaders.RETRY_AFTER, 5);
    });

    it('includes retryAfter in the 429 response body', async () => {
      const { guard } = buildGuard({ evaluation: { result: DENIED_RESULT, failOpen: false } });
      const { ctx } = createMockExecutionContext();

      const err = await guard.canActivate(ctx).catch((e: unknown) => e);
      const body = (err as HttpException).getResponse() as { retryAfter: number };
      expect(body.retryAfter).toBe(5);
    });

    it('uses a custom static errorMessage string in the response body', async () => {
      const { guard } = buildGuard({
        evaluation: { result: DENIED_RESULT, failOpen: false },
        moduleOptions: { errorMessage: 'Custom rate limit message' },
      });
      const { ctx } = createMockExecutionContext();

      const err = await guard.canActivate(ctx).catch((e: unknown) => e);
      const body = (err as HttpException).getResponse() as { message: string };
      expect(body.message).toBe('Custom rate limit message');
    });

    it('resolves an async errorMessage factory before throwing', async () => {
      const { guard } = buildGuard({
        evaluation: { result: DENIED_RESULT, failOpen: false },
        moduleOptions: { errorMessage: () => Promise.resolve('Dynamic message') },
      });
      const { ctx } = createMockExecutionContext();

      const err = await guard.canActivate(ctx).catch((e: unknown) => e);
      const body = (err as HttpException).getResponse() as { message: string };
      expect(body.message).toBe('Dynamic message');
    });

    it('suppresses all headers (including Retry-After) when setHeaders: false', async () => {
      const { guard } = buildGuard({
        evaluation: { result: DENIED_RESULT, failOpen: false },
        moduleOptions: { setHeaders: false },
      });
      const { ctx, mock } = createMockExecutionContext();

      await guard.canActivate(ctx).catch(() => {
        /* expected */
      });
      expect(mock.response.setHeader).not.toHaveBeenCalled();
    });
  });
});
