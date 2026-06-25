export const TOKEN_BUCKET_SCRIPT = `
-- Token Bucket algorithm implemented as an atomic Redis Lua script.
--
-- All reads and writes happen within a single atomic operation, eliminating
-- race conditions across distributed application instances.
--
-- KEYS[1]  - The rate limit bucket key (namespaced externally before calling)
-- ARGV[1]  - capacity       (number)  Max tokens the bucket can hold
-- ARGV[2]  - refillRate     (number)  Tokens restored per second (0 = fixed capacity)
-- ARGV[3]  - requestedCost  (number)  Tokens required for the current request (0 = peek)
-- ARGV[4]  - ttl            (number)  Key TTL in seconds (capacity / refillRate * 2)
--
-- Returns a table with 5 values:
--   [1] allowed      (0 or 1)  Whether the request is permitted
--   [2] remaining    (number)  Tokens remaining after this operation
--   [3] limit        (number)  Bucket capacity (echoed back for headers)
--   [4] resetAt      (number)  Unix timestamp when bucket will be full
--   [5] retryAfter   (number)  Seconds to wait on rejection; 0 = no retry possible

local key           = KEYS[1]
local capacity      = tonumber(ARGV[1])
local refillRate    = tonumber(ARGV[2])
local requestedCost = tonumber(ARGV[3])
local ttl           = tonumber(ARGV[4])

-- Use Redis TIME for server-side timestamp to avoid client clock skew.
-- TIME returns {seconds, microseconds}; we only need second-level precision.
local now = tonumber(redis.call('TIME')[1])

-- Load existing bucket state
local bucket        = redis.call('HMGET', key, 'tokens', 'lastRefill')
local currentTokens = tonumber(bucket[1])
local lastRefill    = tonumber(bucket[2])

if currentTokens == nil then
  -- First request: initialize a full bucket
  currentTokens = capacity
  lastRefill    = now
end

-- Calculate how many tokens have been restored since the last request
local elapsed        = math.max(0, now - lastRefill)
local restoredTokens = elapsed * refillRate

-- Apply refill, clamped to capacity (cannot exceed the bucket size)
local newTokens = math.min(capacity, currentTokens + restoredTokens)

-- Note on precision: Lua numbers are double-precision floats.
-- Accumulating 'restoredTokens' via multiplication (elapsed * refillRate)
-- avoids iterative drift. However, fractional 'newTokens' are maintained
-- natively. For most use cases this is perfect. At very low refill rates
-- (e.g., 0.0001), IEEE 754 precision limits are mathematically negligible
-- for rate limiting contexts.

-- Guard: If the requested cost exceeds the bucket's maximum capacity,
-- the request is fundamentally impossible to fulfill.
-- We persist the refilled state but return allowed=0 and retryAfter=0 (no retry possible).
if requestedCost > capacity then
  redis.call('HSET', key, 'tokens', newTokens, 'lastRefill', now)
  redis.call('EXPIRE', key, ttl)
  return { 0, newTokens, capacity, now, 0 }
end

-- Special case: cost=0 is a read-only peek.
-- Returns current state without modifying the bucket.
-- We intentionally do NOT update 'lastRefill' here. If we updated it without 
-- deducting tokens, we would shift the refill timeline and introduce hidden drift,
-- secretly penalizing or rewarding the client on subsequent requests.
if requestedCost == 0 then
  local peekResetAt = now
  if refillRate > 0 then
    peekResetAt = now + math.ceil((capacity - newTokens) / refillRate)
  end
  return { 1, newTokens, capacity, peekResetAt, 0 }
end

-- Special case: refillRate=0 (fixed-capacity bucket, tokens never replenish).
-- Avoids division-by-zero in retryAfter and resetAt calculations.
-- retryAfter=0 signals "no retry possible"; resetAt=now signals "no recovery".
if refillRate == 0 then
  local allowed   = 0
  local remaining = newTokens
  if newTokens >= requestedCost then
    allowed   = 1
    remaining = newTokens - requestedCost
  end
  redis.call('HSET', key, 'tokens', remaining, 'lastRefill', now)
  redis.call('EXPIRE', key, ttl)
  return { allowed, remaining, capacity, now, 0 }
end

-- Normal case: refillRate > 0, requestedCost > 0
local allowed    = 0
local remaining  = newTokens
local retryAfter = 0

if newTokens >= requestedCost then
  -- Sufficient tokens: deduct the cost and allow the request
  allowed   = 1
  remaining = newTokens - requestedCost
else
  -- Insufficient tokens: calculate how long until enough tokens are available
  local deficit = requestedCost - newTokens
  retryAfter = math.ceil(deficit / refillRate)
end

-- Persist updated bucket state
redis.call('HSET', key, 'tokens', remaining, 'lastRefill', now)

-- Refresh TTL on every access; key expires if unused for the full refill window
redis.call('EXPIRE', key, ttl)

-- Calculate Unix timestamp of full refill for X-RateLimit-Reset header
local tokensNeededForFull = capacity - remaining
local secondsToFull       = math.ceil(tokensNeededForFull / refillRate)
local resetAt             = now + secondsToFull

return { allowed, remaining, capacity, resetAt, retryAfter }
`;
