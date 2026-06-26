import { Injectable, Logger, type OnModuleInit, Inject } from '@nestjs/common';
import { type Redis } from 'ioredis';
import { REDIS_CLIENT_TOKEN, MODULE_OPTIONS_TOKEN } from '../constants/metadata.constants.js';
import type { IRateLimitStore } from '../interfaces/rate-limit-store.interface.js';
import type { RateLimitResult } from '../interfaces/rate-limit-result.interface.js';
import type { WeightedRateLimiterOptions } from '../interfaces/module-options.interface.js';
import { TOKEN_BUCKET_SCRIPT } from '../lua/token-bucket.lua.js';

/**
 * Redis-backed token bucket store.
 *
 * Uses a Lua script executed atomically via EVALSHA to eliminate race conditions
 * across distributed instances. Falls back to EVAL when Redis loses the cached
 * script (e.g., after a restart).
 */
@Injectable()
export class RedisStore implements IRateLimitStore, OnModuleInit {
  private readonly logger = new Logger(RedisStore.name);
  private scriptSha: string | null = null;
  private readonly TTL_MULTIPLIER = 2;
  // Hard cap to prevent extremely slow-refill policies from creating very long-lived keys
  private readonly MAX_TTL_SECONDS = 86_400; // 24 hours

  constructor(
    @Inject(REDIS_CLIENT_TOKEN) private readonly redis: Redis,
    @Inject(MODULE_OPTIONS_TOKEN) private readonly options: WeightedRateLimiterOptions,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.scriptSha = (await this.redis.script('LOAD', TOKEN_BUCKET_SCRIPT)) as string;
      this.logger.log(`Token bucket script loaded (SHA: ${this.scriptSha})`);
    } catch (err) {
      this.logger.warn('Failed to preload Lua script, will fall back to EVAL', err);
    }
  }

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
    cost: number,
  ): Promise<RateLimitResult> {
    const namespacedKey = this.buildKey(key);
    // Keep buckets alive for 2× the refill window; idle keys expire automatically.
    // Capped at MAX_TTL_SECONDS to prevent slow-refill policies from bloating Redis.
    const ttl = Math.min(
      Math.ceil((capacity / refillRate) * this.TTL_MULTIPLIER),
      this.MAX_TTL_SECONDS,
    );
    const raw = await this.executeScript(namespacedKey, capacity, refillRate, cost, ttl);
    return this.deserialize(raw, capacity);
  }

  private async executeScript(
    key: string,
    capacity: number,
    refillRate: number,
    cost: number,
    ttl: number,
  ): Promise<Array<number>> {
    const argv = [capacity, refillRate, cost, ttl].map(String);

    if (this.scriptSha) {
      try {
        return (await this.redis.evalsha(this.scriptSha, 1, key, ...argv)) as Array<number>;
      } catch (err) {
        if (!this.isNoscriptError(err)) throw err;
        // Redis was restarted and the script cache was flushed.
        // Reload the script and immediately retry with EVALSHA — avoids sending
        // the full script body (which EVAL would do) on every subsequent request.
        this.logger.warn('NOSCRIPT: reloading Lua script after Redis restart');
        this.scriptSha = (await this.redis.script('LOAD', TOKEN_BUCKET_SCRIPT)) as string;
        return (await this.redis.evalsha(this.scriptSha, 1, key, ...argv)) as Array<number>;
      }
    }

    // scriptSha is null — initial SCRIPT LOAD failed (e.g., Redis unavailable at startup).
    // Fall back to EVAL which sends the script body inline; safe but slightly slower.
    return (await this.redis.eval(TOKEN_BUCKET_SCRIPT, 1, key, ...argv)) as Array<number>;
  }

  private buildKey(key: string): string {
    return `${this.options.keyPrefix ?? 'wrl'}:${key}`;
  }

  private isNoscriptError(err: unknown): boolean {
    return err instanceof Error && err.message.startsWith('NOSCRIPT');
  }

  /** Lua returns: [allowed(0|1), remaining, capacity, resetAt, retryAfter] */
  private deserialize(raw: Array<number>, capacity: number): RateLimitResult {
    const [allowed, remaining, limit, resetAt, retryAfter] = raw;
    return {
      allowed: allowed === 1,
      remaining: remaining ?? 0,
      limit: limit ?? capacity,
      resetAt: resetAt ?? 0,
      retryAfter: retryAfter ?? 0,
    };
  }
}
