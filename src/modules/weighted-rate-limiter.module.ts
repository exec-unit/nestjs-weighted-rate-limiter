import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Redis, Cluster } from 'ioredis';
import {
  REDIS_CLIENT_TOKEN,
  MODULE_OPTIONS_TOKEN,
  RATE_LIMIT_STORE_TOKEN,
} from '../constants/metadata.constants.js';
import { RedisStore } from '../store/redis.store.js';
import { WeightedRateLimiterService } from '../services/weighted-rate-limiter.service.js';
import { WeightedRateLimiterGuard } from '../guards/weighted-rate-limiter.guard.js';
import type {
  WeightedRateLimiterOptions,
  WeightedRateLimiterAsyncOptions,
  WeightedRateLimiterOptionsFactory,
} from '../interfaces/module-options.interface.js';

/**
 * Internal DI token that flags whether the Redis client was created by this
 * module (`true`) or passed in by the caller (`false`).
 * Only managed connections are closed on application shutdown.
 */
const MANAGED_REDIS_TOKEN = 'WEIGHTED_RATE_LIMITER_MANAGED_REDIS';

/**
 * Closes the ioredis client when the application shuts down.
 * Skipped when the caller passed an existing client (`type: 'existing'`),
 * because lifetime management of that connection is the caller's responsibility.
 */
@Injectable()
class RedisConnectionManager implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CLIENT_TOKEN) private readonly redis: Redis | Cluster,
    @Inject(MANAGED_REDIS_TOKEN) private readonly isManaged: boolean,
  ) {}

  async onApplicationShutdown(_signal?: string): Promise<void> {
    if (!this.isManaged) return;
    try {
      await this.redis.quit();
    } catch {
      // Connection was already closed — safe to ignore
    }
  }
}

/**
 * Root NestJS dynamic module for `nestjs-weighted-rate-limiter`.
 *
 * Register once at the application root. The module is global by default,
 * making `WeightedRateLimiterGuard` and `WeightedRateLimiterService` available
 * across the entire application without re-importing.
 *
 * @example
 * Static configuration:
 * ```typescript
 * WeightedRateLimiterModule.forRoot({
 *   redis: { type: 'single', options: { host: 'localhost', port: 6379 } },
 *   keyPrefix: 'myapp:rl',
 *   failOpen: false,
 * })
 * ```
 *
 * @example
 * Async configuration via ConfigService:
 * ```typescript
 * WeightedRateLimiterModule.forRootAsync({
 *   imports: [ConfigModule],
 *   inject: [ConfigService],
 *   useFactory: (config: ConfigService) => ({
 *     redis: { type: 'single', options: { host: config.get('REDIS_HOST') } },
 *   }),
 * })
 * ```
 *
 * See README.md for complete AppModule integration examples.
 */
@Module({})
export class WeightedRateLimiterModule {
  /** Registers the module with static, synchronous options. */
  static forRoot(options: WeightedRateLimiterOptions): DynamicModule {
    const providers: Array<Provider> = [
      { provide: MODULE_OPTIONS_TOKEN, useValue: options },
      {
        provide: REDIS_CLIENT_TOKEN,
        useFactory: () => WeightedRateLimiterModule.buildRedisClient(options),
      },
      { provide: MANAGED_REDIS_TOKEN, useValue: options.redis.type !== 'existing' },
      // Single RedisStore instance; RATE_LIMIT_STORE_TOKEN is an alias for it
      RedisStore,
      { provide: RATE_LIMIT_STORE_TOKEN, useExisting: RedisStore },
      RedisConnectionManager,
      WeightedRateLimiterService,
      WeightedRateLimiterGuard,
      Reflector,
    ];

    return {
      module: WeightedRateLimiterModule,
      global: true,
      providers,
      exports: [WeightedRateLimiterGuard, WeightedRateLimiterService, MODULE_OPTIONS_TOKEN],
    };
  }

  /**
   * Registers the module with async options.
   * Use when module options depend on other injectable providers (e.g., ConfigService).
   */
  static forRootAsync(asyncOptions: WeightedRateLimiterAsyncOptions): DynamicModule {
    const asyncProviders = WeightedRateLimiterModule.createAsyncOptionsProviders(asyncOptions);

    const providers: Array<Provider> = [
      ...asyncProviders,
      {
        provide: REDIS_CLIENT_TOKEN,
        inject: [MODULE_OPTIONS_TOKEN],
        useFactory: (options: WeightedRateLimiterOptions) =>
          WeightedRateLimiterModule.buildRedisClient(options),
      },
      {
        provide: MANAGED_REDIS_TOKEN,
        inject: [MODULE_OPTIONS_TOKEN],
        useFactory: (options: WeightedRateLimiterOptions) => options.redis.type !== 'existing',
      },
      // Single RedisStore instance; RATE_LIMIT_STORE_TOKEN is an alias for it
      RedisStore,
      { provide: RATE_LIMIT_STORE_TOKEN, useExisting: RedisStore },
      RedisConnectionManager,
      WeightedRateLimiterService,
      WeightedRateLimiterGuard,
      Reflector,
    ];

    return {
      module: WeightedRateLimiterModule,
      global: true,
      imports: asyncOptions.imports ?? [],
      providers,
      exports: [WeightedRateLimiterGuard, WeightedRateLimiterService, MODULE_OPTIONS_TOKEN],
    };
  }

  /**
   * Constructs the appropriate ioredis client based on the configured connection type.
   * When `type: 'existing'`, the caller-managed client is returned as-is.
   */
  private static buildRedisClient(options: WeightedRateLimiterOptions): Redis | Cluster {
    const { redis } = options;

    if (redis.type === 'existing') return redis.client;

    const logger = new Logger('WeightedRateLimiterModule');

    let client: Redis | Cluster;

    if (redis.type === 'cluster') {
      client = new Cluster(redis.startupNodes, redis.options);
    } else {
      client = new Redis(redis.options);
    }

    client.on('connect', () => logger.log('Connected to Redis successfully'));
    client.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Redis connection error: ${msg}`);
    });
    client.on('reconnecting', () => logger.warn('Reconnecting to Redis...'));

    return client;
  }

  /**
   * Builds the provider(s) that supply `MODULE_OPTIONS_TOKEN`.
   *
   * - `useFactory`: single provider, standard NestJS async pattern.
   * - `useClass`: two providers — one instantiates the factory class, the second
   *   calls `createWeightedRateLimiterOptions()` and binds the result to the token.
   *   This matches the pattern used by `@nestjs/jwt` and `@nestjs/typeorm`.
   * - `useExisting`: delegates to an already-registered provider token.
   */
  private static createAsyncOptionsProviders(
    asyncOptions: WeightedRateLimiterAsyncOptions,
  ): Array<Provider> {
    if (asyncOptions.useFactory) {
      return [
        {
          provide: MODULE_OPTIONS_TOKEN,
          inject: asyncOptions.inject ?? [],
          useFactory: asyncOptions.useFactory,
        },
      ];
    }

    if (asyncOptions.useClass) {
      return [
        // Register the factory class so NestJS can inject it
        { provide: asyncOptions.useClass, useClass: asyncOptions.useClass },
        {
          provide: MODULE_OPTIONS_TOKEN,
          inject: [asyncOptions.useClass],
          useFactory: (factory: WeightedRateLimiterOptionsFactory) =>
            factory.createWeightedRateLimiterOptions(),
        },
      ];
    }

    if (asyncOptions.useExisting) {
      return [
        {
          provide: MODULE_OPTIONS_TOKEN,
          inject: [asyncOptions.useExisting],
          useFactory: (factory: WeightedRateLimiterOptionsFactory) =>
            factory.createWeightedRateLimiterOptions(),
        },
      ];
    }

    throw new Error(
      'WeightedRateLimiterModule.forRootAsync() requires useFactory, useClass, or useExisting',
    );
  }
}
