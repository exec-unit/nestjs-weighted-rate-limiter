import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  Inject,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  MODULE_OPTIONS_TOKEN,
  SKIP_WEIGHTED_LIMIT_METADATA,
} from '../constants/metadata.constants.js';
import { RateLimitHeaders } from '../constants/headers.constants.js';
import type { WeightedRateLimiterOptions } from '../interfaces/module-options.interface.js';
import type { RateLimitResult } from '../interfaces/rate-limit-result.interface.js';
import { WeightedRateLimiterService } from '../services/weighted-rate-limiter.service.js';
import { Reflector } from '@nestjs/core';

// Structural duck-type — works with both Express and Fastify without importing either
type HttpResponse = { setHeader(name: string, value: string | number): void };

/**
 * Enforces the weighted rate limiting policy on decorated routes.
 *
 * Intentionally thin: all rate limiting logic lives in `WeightedRateLimiterService`.
 * This guard is responsible only for the binary decision and HTTP response plumbing.
 *
 * @example
 * Global registration in bootstrap():
 * ```typescript
 * async function bootstrap() {
 *   app.useGlobalGuards(app.get(WeightedRateLimiterGuard));
 * }
 * ```
 *
 * See README.md for per-controller and per-route decorator usage.
 */
@Injectable()
export class WeightedRateLimiterGuard implements CanActivate {
  private readonly logger = new Logger(WeightedRateLimiterGuard.name);

  constructor(
    private readonly rateLimiterService: WeightedRateLimiterService,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: WeightedRateLimiterOptions,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // Fast path: route is explicitly opted out — skip all store interaction
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(
      SKIP_WEIGHTED_LIMIT_METADATA,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (skip) return true;

    try {
      const evaluation = await this.rateLimiterService.evaluate(ctx);

      // Route has no @WeightedLimit()
      if (evaluation === null) return true;

      const { result } = evaluation;

      if (this.options.setHeaders !== false) {
        this.setRateLimitHeaders(ctx, result);
      }

      if (result.allowed) return true;

      if (this.options.setHeaders !== false) {
        this.getResponse(ctx).setHeader(RateLimitHeaders.RETRY_AFTER, result.retryAfter);
      }

      // Resolve message (may be async), then throw — avoid throwing a Promise
      const message = await this.resolveMessage(ctx);
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message, retryAfter: result.retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    } catch (err) {
      if (err instanceof HttpException) throw err;
      return this.handleStoreError(err, ctx);
    }
  }

  private setRateLimitHeaders(ctx: ExecutionContext, result: RateLimitResult): void {
    const res = this.getResponse(ctx);
    res.setHeader(RateLimitHeaders.LIMIT, result.limit);
    res.setHeader(RateLimitHeaders.REMAINING, result.remaining);
    res.setHeader(RateLimitHeaders.RESET, result.resetAt);
  }

  private async resolveMessage(ctx: ExecutionContext): Promise<string> {
    const raw = this.options.errorMessage;
    return typeof raw === 'function' ? raw(ctx) : (raw ?? 'Too Many Requests');
  }

  /**
   * Applies fail-open / fail-closed when the store is unreachable.
   *
   * Reads per-route `failOpen` from `@WeightedLimit()` metadata — the service
   * threw before returning a `PolicyEvaluation`, so we re-resolve it here.
   * Falls back to the module-level option when no per-route policy is found.
   */
  private handleStoreError(err: unknown, ctx: ExecutionContext): boolean {
    const policy = this.rateLimiterService.resolvePolicy(ctx);
    const failOpen = policy?.failOpen ?? this.options.failOpen ?? false;
    const error = err instanceof Error ? err : new Error(String(err));

    // Report to observability — the real bucket key was never resolved, so use
    // the handler name as a best-effort identifier for the error metric
    const handlerName = (ctx.getHandler() as { name?: string }).name ?? '(unknown)';
    this.rateLimiterService.reportError(handlerName, error);

    if (failOpen) {
      this.logger.warn(`Rate limiter unavailable, fail-open: ${error.message}`);
      return true;
    }

    this.logger.error(`Rate limiter unavailable, fail-closed: ${error.message}`);
    throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
  }

  private getResponse(ctx: ExecutionContext): HttpResponse {
    return ctx.switchToHttp().getResponse<HttpResponse>();
  }
}
