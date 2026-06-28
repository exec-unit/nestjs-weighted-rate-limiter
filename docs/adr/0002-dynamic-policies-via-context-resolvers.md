# ADR 0002: Dynamic Policies via Context Resolvers

**Status**: Accepted  
**Date**: 2026-06-28

## Context

The primary architectural driver for this library is the need to support complex, multi-tenant B2B platforms. Static decorator configurations (e.g., `@RateLimit({ limit: 100 })`) are insufficient for scenarios where:

- Token capacities depend on the user's billing tier (Free vs Enterprise).
- The bucket key must change based on authentication state (IP address for public routes, Organization ID for authenticated routes).
- The cost of a request depends on the size of the incoming payload (e.g., a bulk insert operation).

If the rate-limiter only accepts primitive values, engineers are forced to write custom middleware or proxy guards that bypass the library's API to fetch state dynamically.

## Decision

The `RateLimitPolicy` interface utilized by the `@WeightedLimit` decorator will accept `ContextResolver` functions for every property (`key`, `capacity`, `refillRate`, `cost`).

A `ContextResolver` is defined as a function that receives the standard NestJS `ExecutionContext` and returns either a synchronous value or a Promise.

## Consequences

### Positive

- **Ultimate Flexibility**. Developers can extract data from headers, inspect body payloads, or perform asynchronous lookups to evaluate limits at runtime directly from the decorator configuration.
- **Separation of Concerns**. Business controllers are not polluted with rate-limiting logic. The metadata cleanly describes how the limit should be calculated for that specific route.
- **Accurate Cost Modeling**. By allowing the `cost` property to be evaluated against the request body, expensive operations (like AI prompt generation or large GraphQL queries) accurately drain the bucket.

### Negative

- **Execution Overhead**. The `WeightedRateLimiterService` must await `Promise.all` for policy resolution on every request before communicating with Redis.
- **Developer Misuse**. If a developer implements a slow database query inside a `ContextResolver`, it will severely degrade route performance. The documentation must clearly advocate for utilizing fast JWT claims or in-memory caches for dynamic resolution.
