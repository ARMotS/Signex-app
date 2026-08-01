/**
 * Rate limiter — in-memory fallback behaviour.
 *
 * These run WITHOUT Upstash configured, which is the degraded path the app
 * falls back to when Redis is unreachable. The important property is that
 * degrading never blocks a legitimate request that the Redis path would have
 * allowed, and that separate identities never share a budget.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  checkRateLimit,
  checkAndRecordRateLimit,
  recordFailedAttempt,
  clearAttempts,
  RATE_LIMITS,
  type RateLimitConfig,
} from "@/lib/rate-limit";

const SHORT: RateLimitConfig = { maxAttempts: 3, windowMs: 60_000 };

/** Unique group per test so counters never leak between cases. */
let group: string;
beforeEach(() => {
  group = `test-${Math.random().toString(36).slice(2)}`;
});

describe("checkAndRecordRateLimit", () => {
  it("allows up to the limit, then blocks", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await checkAndRecordRateLimit("alice", group, SHORT);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(3 - i);
    }

    const blocked = await checkAndRecordRateLimit("alice", group, SHORT);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("keeps separate identities in separate buckets", async () => {
    // This is the NAT case: several people, one shared address, previously one
    // shared budget.
    for (let i = 0; i < 3; i++) {
      await checkAndRecordRateLimit("admin-1", group, SHORT);
    }

    expect((await checkAndRecordRateLimit("admin-1", group, SHORT)).allowed).toBe(false);
    expect((await checkAndRecordRateLimit("admin-2", group, SHORT)).allowed).toBe(true);
  });

  it("keeps separate groups in separate buckets", async () => {
    for (let i = 0; i < 3; i++) {
      await checkAndRecordRateLimit("bob", `${group}-a`, SHORT);
    }

    expect((await checkAndRecordRateLimit("bob", `${group}-a`, SHORT)).allowed).toBe(false);
    expect((await checkAndRecordRateLimit("bob", `${group}-b`, SHORT)).allowed).toBe(true);
  });
});

describe("checkRateLimit", () => {
  it("does not consume budget when only peeking", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await checkRateLimit("carol", group, SHORT);
      expect(res.allowed).toBe(true);
    }
    expect(await checkRateLimit("carol", group, SHORT)).toMatchObject({
      allowed: true,
      remaining: 3,
    });
  });

  it("reflects attempts recorded by recordFailedAttempt", async () => {
    await recordFailedAttempt("dave", group, SHORT);
    await recordFailedAttempt("dave", group, SHORT);

    expect(await checkRateLimit("dave", group, SHORT)).toMatchObject({
      allowed: true,
      remaining: 1,
    });

    await recordFailedAttempt("dave", group, SHORT);
    expect((await checkRateLimit("dave", group, SHORT)).allowed).toBe(false);
  });
});

describe("clearAttempts", () => {
  it("resets the counter, so a successful login restores full budget", async () => {
    for (let i = 0; i < 3; i++) {
      await recordFailedAttempt("erin", group, SHORT);
    }
    expect((await checkRateLimit("erin", group, SHORT)).allowed).toBe(false);

    await clearAttempts("erin", group);

    expect(await checkRateLimit("erin", group, SHORT)).toMatchObject({
      allowed: true,
      remaining: 3,
    });
  });
});

describe("window expiry", () => {
  it("frees the budget again once the window has passed", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) {
        await checkAndRecordRateLimit("frank", group, SHORT);
      }
      expect((await checkAndRecordRateLimit("frank", group, SHORT)).allowed).toBe(false);

      vi.advanceTimersByTime(SHORT.windowMs + 1000);

      expect((await checkAndRecordRateLimit("frank", group, SHORT)).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("configured limits", () => {
  it("gives an admin a larger per-person budget than a driver", () => {
    // Both are per SESSION, so they are directly comparable. Admin pages run
    // several polls at once; a driver runs one.
    expect(RATE_LIMITS.apiAdmin.maxAttempts).toBeGreaterThan(
      RATE_LIMITS.apiDriver.maxAttempts
    );
  });

  it("sizes the anonymous pool for a whole depot signing in at once", () => {
    // apiAnon is NOT comparable to the per-session limits: it is keyed on IP,
    // so one bucket is shared by everyone behind a depot's NAT address. The
    // requirement is that a full shift change fits — roughly 20 drivers each
    // costing a handful of requests before they have a session to key on.
    const DRIVERS_PER_DEPOT = 20;
    const REQUESTS_BEFORE_LOGIN = 5;

    expect(RATE_LIMITS.apiAnon.maxAttempts).toBeGreaterThanOrEqual(
      DRIVERS_PER_DEPOT * REQUESTS_BEFORE_LOGIN
    );
  });

  it("keeps the auth limit tight and long-windowed", () => {
    expect(RATE_LIMITS.auth.maxAttempts).toBeLessThanOrEqual(5);
    expect(RATE_LIMITS.auth.windowMs).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });
});
