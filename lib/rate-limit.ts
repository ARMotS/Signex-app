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
  /**
   * Login/signup, per IP. Counts failures only; a success clears the counter.
   *
   * Deliberately looser than `authUser`: a depot of drivers shares one NAT
   * address, and the day passwords are handed out is the day typos peak. Five
   * per IP would let five mistakes lock out every driver in the building. This
   * one stops spraying many usernames from one address; `authUser` is what
   * stops guessing at any one account.
   */
  auth: {
    maxAttempts: 30,
    windowMs: 15 * 60 * 1000,
  } satisfies RateLimitConfig,

  /**
   * Login, per submitted USERNAME (normalised). The lockout after repeated
   * failures. Counted whether or not the name exists, so a lockout message does
   * not reveal which usernames are real.
   */
  authUser: {
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

/**
 * API writes that keep a SHARED (Redis) budget: uploads, and the requests
 * that parse PDFs or sheets — the expensive work, where a budget split across
 * serverless instances would not hold. Every other API request is counted on
 * its instance only (`shared: false`).
 *
 * ── Why the rest is not shared ────────────────────────────────────────────
 * Upstash bills per command, and one command on every API request — mostly
 * the change-feed and badge polls of open tabs — was nearly the whole bill.
 * The per-session budgets (600/min office, 240/min driver) sit far above any
 * real use; what they guard against is a runaway client loop, and a count on
 * the instance it is hitting stops that just as well, for nothing.
 */
const SHARED_LIMIT_ROUTES: RegExp[] = [
  /^\/api\/invoices\/upload$/,
  /^\/api\/trip-sheet$/,
  /^\/api\/trip-sheet\/folder$/,
  /^\/api\/contacts\/import$/,
  /^\/api\/courier$/,
  /^\/api\/courier\/inbox$/,
  /^\/api\/credit-notes$/,
  /^\/api\/credit-notes\/sync$/,
  /^\/api\/credit-notes\/[^/]+$/,
  /^\/api\/collections\/[^/]+\/sheet$/,
  /^\/api\/import-templates\/preview$/,
];

/** Only POST / PUT: a GET of the same path is a list read (and often a poll). */
export function usesSharedLimit(method: string, pathname: string): boolean {
  if (method !== "POST" && method !== "PUT") return false;
  return SHARED_LIMIT_ROUTES.some((r) => r.test(pathname));
}

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

//
// ── Commands are the bill ─────────────────────────────────────────────────
// Upstash charges per command, so each script below takes ANY number of keys
// and costs one command however many counters it touches: sign-in reads its
// per-IP and per-username counters together rather than one after the other.

/**
 * Increment counters and read their TTLs in one atomic round trip.
 * KEYS[i] is incremented with window ARGV[i]; returns a flat
 * [count1, ttlMs1, count2, ttlMs2, ...].
 *
 * PEXPIRE is set on the first hit of a window, which is what makes this a
 * fixed window rather than a rolling one — and again on any key found with no
 * expiry at all, so a counter can never outlive its window and become a
 * permanent lockout.
 */
const INCR_SCRIPT = `
local out = {}
for i, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  if count == 1 or redis.call('PTTL', key) == -1 then
    redis.call('PEXPIRE', key, ARGV[i])
  end
  out[#out + 1] = count
  out[#out + 1] = redis.call('PTTL', key)
end
return out
`;

/** Read counters and their TTLs without incrementing. Same shape as above. */
const PEEK_SCRIPT = `
local out = {}
for i, key in ipairs(KEYS) do
  local count = redis.call('GET', key)
  if count == false then
    out[#out + 1] = 0
    out[#out + 1] = -1
  else
    out[#out + 1] = tonumber(count)
    out[#out + 1] = redis.call('PTTL', key)
  end
end
return out
`;

// ── Blocked keys are remembered locally ──────────────────────────────────
//
// Once Redis says a key is over its limit, it stays over until its window
// resets: counts only go up within a window, and the only thing that clears
// one early (a successful sign-in) cannot happen while it is blocked — the
// request is refused first. So the answer is cached on this instance until
// the reset, and a client hammering a closed door costs no further commands.
// The same idea as `ephemeralCache` in @upstash/ratelimit.

const blocked = new Map<string, { result: RateLimitResult; resetAt: number }>();

function cachedBlock(key: string): RateLimitResult | null {
  const hit = blocked.get(key);
  if (!hit) return null;
  const now = Date.now();
  if (hit.resetAt <= now) {
    blocked.delete(key);
    return null;
  }
  return {
    ...hit.result,
    retryAfterSeconds: Math.ceil((hit.resetAt - now) / 1000),
  };
}

function rememberIfBlocked(key: string, result: RateLimitResult): RateLimitResult {
  if (!result.allowed) {
    ensureCleanupTimer();
    blocked.set(key, { result, resetAt: result.resetAt });
  }
  return result;
}

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
    for (const [key, hit] of blocked.entries()) {
      if (hit.resetAt <= now) blocked.delete(key);
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
  const [result] = await checkRateLimits([{ identifier, group, config }]);
  return result;
}

/** One counter, as the multi-key functions below take them. */
export interface RateLimitCheck {
  identifier: string;
  group: string;
  config: RateLimitConfig;
}

const keyOf = (c: Pick<RateLimitCheck, "identifier" | "group">) =>
  `rl:${c.group}:${c.identifier}`;

/**
 * Run one script over several counters: ONE Redis command for all of them.
 * Counters already known to be blocked are answered locally and left out of
 * the call; when every counter is, Redis is not called at all.
 */
async function runScript(
  script: string,
  checks: RateLimitCheck[],
  record: boolean,
  label: string
): Promise<RateLimitResult[]> {
  const results: (RateLimitResult | null)[] = checks.map((c) => cachedBlock(keyOf(c)));
  const pending = checks
    .map((check, i) => ({ check, i }))
    .filter(({ i }) => results[i] === null);
  if (pending.length === 0) return results as RateLimitResult[];

  const client = getRedis();
  if (client) {
    try {
      const flat = await client.eval<string[], number[]>(
        script,
        pending.map(({ check }) => keyOf(check)),
        pending.map(({ check }) => String(check.config.windowMs))
      );
      pending.forEach(({ check, i }, n) => {
        results[i] = rememberIfBlocked(
          keyOf(check),
          buildResult(flat[n * 2], flat[n * 2 + 1], check.config)
        );
      });
      return results as RateLimitResult[];
    } catch (err) {
      console.error(`[rate-limit] Redis ${label} failed, allowing request:`, err);
    }
  }

  for (const { check, i } of pending) {
    results[i] = memoryCheck(keyOf(check), check.config, record);
  }
  return results as RateLimitResult[];
}

/**
 * Check several counters WITHOUT recording, in one Redis command. Sign-in
 * reads its per-IP and per-username counters this way.
 */
export function checkRateLimits(checks: RateLimitCheck[]): Promise<RateLimitResult[]> {
  return runScript(PEEK_SCRIPT, checks, false, "peek");
}

/**
 * Check the rate limit AND record the attempt in one call.
 * Used for general request throttling where every request counts.
 *
 * `shared: false` keeps the count on this instance only and never calls
 * Redis — the general API budget, where a per-instance backstop against a
 * runaway client is all that is needed (see middleware.ts).
 */
export async function checkAndRecordRateLimit(
  identifier: string,
  group: string,
  config: RateLimitConfig,
  { shared = true }: { shared?: boolean } = {}
): Promise<RateLimitResult> {
  if (!shared) return memoryCheck(keyOf({ identifier, group }), config, true);
  const [result] = await runScript(INCR_SCRIPT, [{ identifier, group, config }], true, "incr");
  return result;
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
  await recordFailedAttempts([{ identifier, group, config }]);
}

/** Record a failure against several counters in one Redis command. */
export async function recordFailedAttempts(checks: RateLimitCheck[]): Promise<void> {
  // Not runScript: a counter cached as blocked must still be counted here —
  // the cache answers checks, it does not stand in for the record.
  const client = getRedis();
  if (client) {
    try {
      const flat = await client.eval<string[], number[]>(
        INCR_SCRIPT,
        checks.map(keyOf),
        checks.map((c) => String(c.config.windowMs))
      );
      checks.forEach((check, n) =>
        rememberIfBlocked(keyOf(check), buildResult(flat[n * 2], flat[n * 2 + 1], check.config))
      );
      return;
    } catch (err) {
      console.error("[rate-limit] Redis record failed:", err);
    }
  }

  for (const check of checks) memoryCheck(keyOf(check), check.config, true);
}

/**
 * Clear all failed attempts for the given identifier.
 * Call this on successful login to reset the counter.
 */
export async function clearAttempts(
  identifier: string,
  group: string
): Promise<void> {
  await clearAttemptsFor([{ identifier, group }]);
}

/** Clear several counters in one Redis command (a multi-key DEL). */
export async function clearAttemptsFor(
  counters: Pick<RateLimitCheck, "identifier" | "group">[]
): Promise<void> {
  if (counters.length === 0) return;
  const keys = counters.map(keyOf);
  for (const key of keys) blocked.delete(key);

  const client = getRedis();
  if (client) {
    try {
      await client.del(...keys);
      return;
    } catch (err) {
      console.error("[rate-limit] Redis clear failed:", err);
    }
  }

  for (const key of keys) store.delete(key);
}
