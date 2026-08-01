/**
 * Rate limiting, backed by Upstash Redis with an in-memory fallback.
 *
 * ── Why Redis ─────────────────────────────────────────────────────────────
 * The previous implementation kept counters in a module-scope Map. On Vercel
 * every serverless instance has its own, so the limit was simultaneously too
 * strict (one busy instance) and unenforceable (spread across instances). The
 * auth limiter in particular is a security control and has to be shared.
 *
 * ── Why the identifier is usually NOT an IP ───────────────────────────────
 * Five ADMINs working from one branch office share one NAT address. Keying on
 * IP put them in a single bucket, so ordinary use by a full office looked
 * identical to abuse by one machine. Authenticated requests are therefore
 * keyed on the SESSION, giving each person their own budget; only
 * pre-authentication traffic falls back to the IP.
 *
 * ── Fail open, always ─────────────────────────────────────────────────────
 * A driver at a customer's door must not be blocked from capturing a signature
 * because Upstash had a bad minute. Every Redis error degrades to the
 * in-memory limiter rather than rejecting the request.
 *
 * Configure with (both optional — without them the in-memory path is used):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 */

import { getRedis } from "./redis";

interface RateLimitEntry {
  timestamps: number[];
}

export interface RateLimitConfig {
  /** Maximum number of requests allowed within the window */
  maxAttempts: number;
  /** Time window in milliseconds */
  windowMs: number;
}

// ─── Limits ───────────────────────────────────────────────────────────────

/**
 * Per-identity budgets. The API limits are per SESSION, not per IP, so these
 * are what one person can do in a minute — not one office.
 */
export const RATE_LIMITS = {
  /** Login/signup, per IP. Counts failures only; a success clears the counter. */
  auth: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000,
  } satisfies RateLimitConfig,

  /**
   * Unauthenticated API traffic, per IP.
   *
   * Sized for SHIFT CHANGE, which is the worst case: a whole depot of drivers
   * arrives on one WiFi network at 6am and loads the sign-in page together.
   * They have no session yet, so they all share the depot's NAT address, and
   * each one costs several requests before logging in. At 60/min a 20-driver
   * depot would start seeing 429s at exactly the wrong moment.
   *
   * This is not the credential control — that is `auth` below, which counts
   * failures only and is unaffected by this number.
   */
  apiAnon: {
    maxAttempts: 300,
    windowMs: 60 * 1000,
  } satisfies RateLimitConfig,

  /**
   * One signed-in driver. Covers the run-sheet poll, status updates and
   * signature uploads with a wide margin.
   */
  apiDriver: {
    maxAttempts: 240,
    windowMs: 60 * 1000,
  } satisfies RateLimitConfig,

  /**
   * One signed-in admin. Admin pages are chatty — dashboard, trip sheets,
   * contacts, the cloud-folder poll and the live-update poll all run together.
   */
  apiAdmin: {
    maxAttempts: 600,
    windowMs: 60 * 1000,
  } satisfies RateLimitConfig,

  /** Retained for compatibility; prefer the role-specific limits above. */
  api: {
    maxAttempts: 60,
    windowMs: 60 * 1000,
  } satisfies RateLimitConfig,
} as const;

export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of remaining requests in the current window */
  remaining: number;
  /** Maximum attempts allowed */
  limit: number;
  /** Unix timestamp (ms) when the window resets */
  resetAt: number;
  /** Seconds until the window resets */
  retryAfterSeconds: number;
}

// ─── Redis ────────────────────────────────────────────────────────────────
//
// The client itself lives in lib/redis.ts so the distributed lock can share it.

/**
 * Increment a counter and read its TTL in one atomic round trip.
 * Returns [count, ttlMs]. PEXPIRE is set only on the first hit of a window,
 * which is what makes this a fixed window rather than a rolling one.
 */
const INCR_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('PTTL', KEYS[1])}
`;

/** Read a counter and its TTL without incrementing. */
const PEEK_SCRIPT = `
local count = redis.call('GET', KEYS[1])
if count == false then
  return {0, -1}
end
return {tonumber(count), redis.call('PTTL', KEYS[1])}
`;

function buildResult(
  count: number,
  ttlMs: number,
  config: RateLimitConfig
): RateLimitResult {
  const effectiveTtl = ttlMs > 0 ? ttlMs : config.windowMs;
  const resetAt = Date.now() + effectiveTtl;

  return {
    allowed: count <= config.maxAttempts,
    remaining: Math.max(0, config.maxAttempts - count),
    limit: config.maxAttempts,
    resetAt,
    retryAfterSeconds: Math.ceil(effectiveTtl / 1000),
  };
}

// ─── In-memory fallback ───────────────────────────────────────────────────

/** Store: key = `${routeGroup}:${identifier}` → entry */
const store = new Map<string, RateLimitEntry>();

/** Cleanup interval — purge expired entries every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      // Remove timestamps older than 15 minutes (max window we use)
      entry.timestamps = entry.timestamps.filter(
        (ts) => now - ts < 15 * 60 * 1000
      );
      if (entry.timestamps.length === 0) {
        store.delete(key);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  // Allow the process to exit without waiting for this timer
  if (cleanupTimer && typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
    cleanupTimer.unref();
  }
}

function memoryCheck(
  key: string,
  config: RateLimitConfig,
  record: boolean
): RateLimitResult {
  ensureCleanupTimer();

  const now = Date.now();
  const windowStart = now - config.windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

  const allowed = entry.timestamps.length < config.maxAttempts;
  if (allowed && record) entry.timestamps.push(now);

  const oldest = entry.timestamps[0];
  const resetAt = oldest ? oldest + config.windowMs : now + config.windowMs;

  return {
    allowed,
    remaining: Math.max(0, config.maxAttempts - entry.timestamps.length),
    limit: config.maxAttempts,
    resetAt,
    retryAfterSeconds: Math.ceil((resetAt - now) / 1000),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Check rate limit status WITHOUT recording the attempt.
 * Used for auth routes, where only failures should count.
 */
export async function checkRateLimit(
  identifier: string,
  group: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const key = `rl:${group}:${identifier}`;
  const client = getRedis();

  if (client) {
    try {
      const [count, ttl] = await client.eval<[string], [number, number]>(
        PEEK_SCRIPT,
        [key],
        [String(config.windowMs)]
      );
      return buildResult(count, ttl, config);
    } catch (err) {
      console.error("[rate-limit] Redis peek failed, allowing request:", err);
    }
  }

  return memoryCheck(key, config, false);
}

/**
 * Check the rate limit AND record the attempt in one call.
 * Used for general request throttling where every request counts.
 */
export async function checkAndRecordRateLimit(
  identifier: string,
  group: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const key = `rl:${group}:${identifier}`;
  const client = getRedis();

  if (client) {
    try {
      const [count, ttl] = await client.eval<[string], [number, number]>(
        INCR_SCRIPT,
        [key],
        [String(config.windowMs)]
      );
      return buildResult(count, ttl, config);
    } catch (err) {
      console.error("[rate-limit] Redis incr failed, allowing request:", err);
    }
  }

  return memoryCheck(key, config, true);
}

/**
 * Record a failed attempt.
 * Call this ONLY on failed login — successful logins should not be counted.
 */
export async function recordFailedAttempt(
  identifier: string,
  group: string,
  config: RateLimitConfig
): Promise<void> {
  const key = `rl:${group}:${identifier}`;
  const client = getRedis();

  if (client) {
    try {
      await client.eval(INCR_SCRIPT, [key], [String(config.windowMs)]);
      return;
    } catch (err) {
      console.error("[rate-limit] Redis record failed:", err);
    }
  }

  memoryCheck(key, config, true);
}

/**
 * Clear all failed attempts for the given identifier.
 * Call this on successful login to reset the counter.
 */
export async function clearAttempts(
  identifier: string,
  group: string
): Promise<void> {
  const key = `rl:${group}:${identifier}`;
  const client = getRedis();

  if (client) {
    try {
      await client.del(key);
      return;
    } catch (err) {
      console.error("[rate-limit] Redis clear failed:", err);
    }
  }

  store.delete(key);
}
