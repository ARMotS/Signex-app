/**
 * A short-lived distributed mutex, on top of Upstash Redis.
 *
 * Used where the same work would otherwise be done concurrently by several
 * serverless instances and the duplication is harmful rather than merely
 * wasteful — the OneDrive token refresh being the case that prompted it.
 *
 * ── Deliberately NOT a general-purpose lock ───────────────────────────────
 * It has a fixed TTL and no renewal, so a holder that outlives the TTL loses
 * the lock while still running. That is acceptable only because every caller
 * here is also protected by a compare-and-swap on the write itself: the lock is
 * an optimisation that avoids wasted work, not the thing that guarantees
 * correctness. Do not use it for anything that relies on mutual exclusion
 * alone.
 *
 * ── Fails open ────────────────────────────────────────────────────────────
 * With no Redis configured, or Redis unreachable, acquire() reports success.
 * A driver at a customer's door must not be blocked from capturing a signature
 * because a cache was down.
 */

import { getRedis } from "./redis";

/** Long enough for a token exchange with Microsoft, short enough to self-heal. */
const DEFAULT_TTL_MS = 10_000;

export interface LockHandle {
  key: string;
  /** Random per acquisition, so a holder can only release its OWN lock. */
  token: string;
  /** True when no Redis was available and the lock was assumed. */
  degraded: boolean;
}

/**
 * Release only if we still hold it. Without the token check, a holder that
 * overran its TTL would delete a lock since acquired by someone else.
 */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Try to take the lock. Returns null when someone else holds it.
 */
export async function acquireLock(
  key: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<LockHandle | null> {
  const redis = getRedis();
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  if (!redis) {
    return { key, token, degraded: true };
  }

  try {
    const res = await redis.set(key, token, { nx: true, px: ttlMs });
    return res === "OK" ? { key, token, degraded: false } : null;
  } catch (err) {
    console.error("[lock] acquire failed, proceeding without it:", err);
    return { key, token, degraded: true };
  }
}

export async function releaseLock(handle: LockHandle): Promise<void> {
  if (handle.degraded) return;

  const redis = getRedis();
  if (!redis) return;

  try {
    await redis.eval(RELEASE_SCRIPT, [handle.key], [handle.token]);
  } catch (err) {
    // Not fatal: the TTL will clear it shortly.
    console.error("[lock] release failed, relying on TTL:", err);
  }
}
