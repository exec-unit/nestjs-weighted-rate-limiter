# ADR 0001: Atomic Token Bucket via embedded Lua Script

**Status**: Accepted  
**Date**: 2026-06-28

## Context

The `nestjs-weighted-rate-limiter` is designed to operate in horizontally scaled environments (e.g., Kubernetes clusters running multiple Node.js replicas). All state must be persisted in a centralized Redis instance.

Standard rate-limiting approaches (like Fixed Window algorithms using `INCR` and `EXPIRE`) suffer from boundary spikes. To support weighted requests (where endpoints consume variable amounts of capacity) and smooth traffic shaping, a Token Bucket algorithm is required.

Implementing a Token Bucket in Node.js by performing a `GET`, calculating the refill locally, and sending a `SET` back to Redis creates race conditions. Under high concurrency, multiple pods reading the same bucket state will overwrite each other, allowing users to bypass their limits. Utilizing distributed locks introduces unacceptable latency overhead for a rate limiter that runs on every HTTP request.

## Decision

The Token Bucket state evaluation and mutation will be executed entirely within a single Redis Lua script.

The Node.js `RedisStore` implementation will pass the evaluated capacity, refill rate, and requested cost as arguments to the script via the `EVALSHA` command.

## Consequences

### Positive

- **Guaranteed Atomicity**. Redis executes Lua scripts synchronously and atomically. Race conditions are completely eliminated at the data store level.
- **Zero Round-Trips**. The entire read-compute-write cycle happens in one network round trip.
- **High Performance**. By using `EVALSHA`, the script is pre-loaded into the Redis cache during module initialization. Only the SHA1 hash and the arguments are sent over the wire.

### Negative

- **Script Cache Flushing**. If the Redis server restarts or the script cache is flushed, the `EVALSHA` command will fail with a `NOSCRIPT` error. The `RedisStore` is required to catch this specific error, automatically execute `SCRIPT LOAD`, and retry the operation to maintain resilience.
- **Data Type Casting**. Lua treats numbers as double-precision floats, while Redis returns them to Node.js as integers. The script must explicitly handle precision and rounding.
