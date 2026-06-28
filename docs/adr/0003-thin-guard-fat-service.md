# ADR 0003: Thin Guard, Fat Service Architecture

**Status**: Accepted  
**Date**: 2026-06-28

## Context

In NestJS, a Guard intercepts requests to evaluate conditions. A common anti-pattern in the ecosystem is tightly coupling domain logic, Redis clients, and configuration parsing directly inside the Guard class.

If `WeightedRateLimiterGuard` directly implemented the token bucket coordination, it would become tightly coupled to the HTTP execution context. This creates friction when developers need to manually apply rate limits outside of HTTP controllers (e.g., within background job processors or internal services), and makes unit testing unnecessarily complex due to the need to mock HTTP objects.

## Decision

The architecture will enforce a strict separation of concerns through a "Thin Guard, Fat Service" pattern.

- **`WeightedRateLimiterGuard`**. Responsible exclusively for HTTP plumbing. It checks for skip decorators, invokes the Service, sets `X-RateLimit` headers on the response, and throws `HttpException` (429) if denied.
- **`WeightedRateLimiterService`**. Contains all rate-limiting domain logic. It parses the `Reflector` metadata, executes the `ContextResolvers`, communicates with the Redis store, processes observability metrics, and handles the fail-open fallback logic.

## Consequences

### Positive

- **High Testability**. The core domain logic inside `WeightedRateLimiterService` can be comprehensively unit tested using a mock `InMemoryRateLimitStore`, entirely decoupled from HTTP Request/Response objects.
- **Protocol Agnostic Core**. The Service returns a standardized `PolicyEvaluation` object. This allows future iterations of the library to support WebSockets, GraphQL, or gRPC by simply creating new thin Guards that interpret the `PolicyEvaluation` for their respective protocols.
- **Isolated Error Handling**. Redis connection failures are processed within the Service to determine the fail-open/fail-closed state, ensuring the Guard receives a clean boolean decision rather than raw connection errors.

### Negative

- **Abstraction Overhead**. Passing data between the Guard and the Service requires internal data structures, slightly increasing the codebase surface area.
