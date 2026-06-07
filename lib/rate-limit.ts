/**
 * In-memory rate limiter using a sliding window approach.
 * Tracks requests per IP with configurable limits per route group.
 *
 * Note: This is an in-memory store — it resets on server restart and
 * is per-process. For multi-instance deployments, use Redis instead.
 */

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitConfig {
  /** Maximum number of requests allowed within the window */
  maxAttempts: number;
  /** Time window in milliseconds */
  windowMs: number;
}

/** Store: key = `${routeGroup}:${ip}` → entry */
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

/**
 * Pre-defined rate limit configurations
 */
export const RATE_LIMITS = {
  /** Login/signup routes: 5 attempts per 15 minutes */
  auth: {
    maxAttempts: 5,
    windowMs: 15 * 60 * 1000, // 15 minutes
  } satisfies RateLimitConfig,

  /** General API routes: 60 requests per minute */
  api: {
    maxAttempts: 60,
    windowMs: 60 * 1000, // 1 minute
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

/**
 * Check rate limit status WITHOUT recording the attempt.
 * The attempt should only be recorded on failure via recordFailedAttempt().
 *
 * @param identifier - Unique identifier, typically the client IP
 * @param group - Rate limit group name (used as a prefix in the store key)
 * @param config - Rate limit configuration (maxAttempts + windowMs)
 * @returns RateLimitResult with allowed status and metadata
 */
export function checkRateLimit(
  identifier: string,
  group: string,
  config: RateLimitConfig
): RateLimitResult {
  ensureCleanupTimer();

  const key = `${group}:${identifier}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Remove timestamps outside the current window
  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

  const currentCount = entry.timestamps.length;

  if (currentCount >= config.maxAttempts) {
    const oldestInWindow = entry.timestamps[0];
    const resetAt = oldestInWindow + config.windowMs;
    const retryAfterSeconds = Math.ceil((resetAt - now) / 1000);

    return {
      allowed: false,
      remaining: 0,
      limit: config.maxAttempts,
      resetAt,
      retryAfterSeconds,
    };
  }

  const remaining = config.maxAttempts - currentCount;
  const resetAt = entry.timestamps.length > 0
    ? entry.timestamps[0] + config.windowMs
    : now + config.windowMs;
  const retryAfterSeconds = Math.ceil((resetAt - now) / 1000);

  return {
    allowed: true,
    remaining,
    limit: config.maxAttempts,
    resetAt,
    retryAfterSeconds,
  };
}

/**
 * Check rate limit AND record the attempt in one call.
 * Use for general request throttling where every request counts.
 */
export function checkAndRecordRateLimit(
  identifier: string,
  group: string,
  config: RateLimitConfig
): RateLimitResult {
  const result = checkRateLimit(identifier, group, config);
  if (result.allowed) {
    const key = `${group}:${identifier}`;
    const entry = store.get(key)!;
    entry.timestamps.push(Date.now());
    result.remaining = config.maxAttempts - entry.timestamps.length;
  }
  return result;
}

/**
 * Record a failed attempt for the given identifier.
 * Call this ONLY on failed login — successful logins should not be counted.
 */
export function recordFailedAttempt(
  identifier: string,
  group: string,
  config: RateLimitConfig
): void {
  ensureCleanupTimer();

  const key = `${group}:${identifier}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);
  entry.timestamps.push(now);
}

/**
 * Clear all failed attempts for the given identifier.
 * Call this on successful login to reset the counter.
 */
export function clearAttempts(identifier: string, group: string): void {
  const key = `${group}:${identifier}`;
  store.delete(key);
}
