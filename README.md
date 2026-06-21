# NestJS Weighted Rate Limiter

[![npm version](https://img.shields.io/npm/v/nestjs-weighted-rate-limiter.svg)](https://www.npmjs.com/package/nestjs-weighted-rate-limiter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

An enterprise-grade, Redis-backed rate limiter for NestJS, built around an atomic **Token Bucket** algorithm.

## What is this library and when should you use it?

Most rate limiters (like the standard `nestjs-throttler`) count requests. If your limit is 100 requests per minute, a simple `GET /health` counts as 1, and a massive `POST /bulk-import` with 10,000 rows also counts as 1.

In B2B platforms, SaaS products, and AI gateways, treating all requests equally exposes your infrastructure to abuse. You need to limit usage based on the **actual cost** of the operation.

This library solves that problem by introducing **Weighted Costs**. Instead of counting requests, you give users a "bucket of tokens". Each endpoint consumes a specific number of tokens based on how heavy it is.

**Use cases where this library shines:**

- **AI/LLM Gateways**. Deduct tokens based on the expected response size or prompt length, rather than the HTTP request itself.
- **GraphQL APIs**. Deduct tokens based on query complexity (e.g., nested relations cost more).
- **Bulk Operations**. A CSV import endpoint costs 1 token per parsed row.
- **Tiered SaaS Billing**. Free users get a small bucket that refills slowly. Enterprise users get a massive bucket with a dedicated Redis key namespace.

## Core Capabilities

- **Atomic Token Bucket**. Uses a highly optimized, embedded Lua script in Redis (`EVALSHA`) to ensure absolutely zero race conditions across distributed microservices.
- **Weighted Requests**. Limit based on operation cost dynamically.
- **Dynamic Policies**. Define your limits dynamically using `ContextResolver` functions. Resolve tenant IDs from JWTs, compute payload sizes, or pull tier limits from a database all at runtime.
- **Fail-Open Resilience**. Explicitly handle Redis outages. Choose whether to allow requests through (`failOpen: true`) or block them (`failOpen: false`) globally or on a per-route basis.
- **Observability Built-In**. Zero-overhead hooks for Prometheus, Datadog, or OpenTelemetry.
- **Standards Compliant**. Automatically injects `X-RateLimit-*` and `Retry-After` headers following the IETF Draft.

## Installation

```bash
pnpm add nestjs-weighted-rate-limiter ioredis
```

## Quick Start

### 1. Register the Module

Import `WeightedRateLimiterModule` into your root `AppModule`. The module is global by default.

```typescript
import { Module } from '@nestjs/common';
import { WeightedRateLimiterModule } from 'nestjs-weighted-rate-limiter';

@Module({
  imports: [
    WeightedRateLimiterModule.forRoot({
      redis: {
        type: 'single',
        options: { host: 'localhost', port: 6379 },
      },
      // Prevents collisions in a shared Redis instance
      keyPrefix: 'myapp:rl',
      // Reject requests if Redis goes down
      failOpen: false,
    }),
  ],
})
export class AppModule {}
```

### 2. Register the Guard

Register the `WeightedRateLimiterGuard` globally to protect all routes by default, or apply it to specific controllers.

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { WeightedRateLimiterGuard } from 'nestjs-weighted-rate-limiter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Get the guard from the DI container so it can access Redis
  app.useGlobalGuards(app.get(WeightedRateLimiterGuard));

  await app.listen(3000);
}
bootstrap();
```

### 3. Dynamic Business Rules

Use the `@WeightedLimit()` decorator to define complex, dynamic policies. The example below demonstrates how to extract the user's billing tier from the request, dynamically set the bucket capacity, and charge tokens based on the complexity of the payload.

```typescript
import { Controller, Post, Body } from '@nestjs/common';
import { WeightedLimit } from 'nestjs-weighted-rate-limiter';

@Controller('ai')
export class AiController {
  @Post('generate')
  @WeightedLimit({
    // Isolate buckets by Organization ID
    key: (ctx) => {
      const request = ctx.switchToHttp().getRequest();
      return `org:${request.user.organizationId}`;
    },

    // Enterprise gets 100,000 tokens, Free tier gets 1,000
    capacity: (ctx) => {
      const request = ctx.switchToHttp().getRequest();
      return request.user.tier === 'enterprise' ? 100000 : 1000;
    },

    // Tokens refill at different speeds based on tier
    refillRate: (ctx) => {
      const request = ctx.switchToHttp().getRequest();
      return request.user.tier === 'enterprise' ? 500 : 10;
    },

    // Charge tokens based on the requested token generation length
    cost: (ctx) => {
      const body = ctx.switchToHttp().getRequest().body;
      const baseCost = 10;
      const lengthCost = body.maxTokens || 100;
      return baseCost + lengthCost;
    },
  })
  generateText(@Body() body: any) {
    return 'Text generated successfully.';
  }
}
```

## Advanced Usage

### Async Configuration

Use `forRootAsync` when you need to inject services like `ConfigService`.

```typescript
WeightedRateLimiterModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    redis: {
      type: 'single',
      options: { host: config.get('REDIS_HOST') },
    },
  }),
});
```

### Observability Metrics

Provide a custom implementation of `RateLimitMetrics` to intercept rate-limiting events without bloating your business logic.

```typescript
import { RateLimitMetrics } from 'nestjs-weighted-rate-limiter';
import { Counter } from 'prom-client';

export class PrometheusMetrics implements RateLimitMetrics {
  private readonly allowed = new Counter({ name: 'rl_allowed_total', help: '...' });
  private readonly rejected = new Counter({ name: 'rl_rejected_total', help: '...' });

  onAllowed(key: string, cost: number, remaining: number) {
    this.allowed.inc({ key }, cost);
  }

  onRejected(key: string, cost: number, retryAfter: number) {
    this.rejected.inc({ key });
  }

  onError(key: string, error: Error) {
    // Implement custom error logging
  }
}
```

Pass this to the module options via `metrics: new PrometheusMetrics()`.

## Documentation

- [Architecture Overview](./docs/ARCHITECTURE.md)
- [Architecture Decision Records (ADRs)](./docs/adr/)

## License

MIT
