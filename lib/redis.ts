/**
 * Upstash Redis client, shared by the rate limiter and the distributed lock.
 *
 * Resolved lazily and never at import time: this module is pulled in during
 * `next build` and by unit tests that have no Redis, and a missing config must
 * degrade rather than break the build. Same rule as TOKEN_ENCRYPTION_KEY in
 * lib/crypto.ts and the database URL in lib/db.ts.
 *
 * Every caller MUST treat `null` as "carry on without Redis". Nothing in this
 * application is allowed to stop working because a cache is unreachable.
 */

import { Redis } from "@upstash/redis";

let client: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (client !== undefined) return client;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  client = url && token ? new Redis({ url, token }) : null;

  if (!client && process.env.NODE_ENV === "production") {
    console.warn(
      "[redis] UPSTASH_REDIS_REST_URL / _TOKEN are not set. Rate limits fall " +
        "back to per-instance counters and cross-instance locking is disabled."
    );
  }

  return client;
}

/** Test seam — forces the next getRedis() to re-read the environment. */
export function resetRedisForTests(): void {
  client = undefined;
}
