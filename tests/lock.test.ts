/**
 * Distributed lock semantics.
 *
 * The lock is an optimisation — it stops several serverless instances doing the
 * same expensive work — and correctness at each call site rests on a
 * compare-and-swap, not on the lock. These tests pin down the two properties
 * that make it useful anyway: it genuinely excludes, and a holder that overran
 * its TTL cannot delete a lock somebody else has since taken.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Minimal in-memory stand-in for the Upstash client. */
class FakeRedis {
  store = new Map<string, string>();
  failing = false;

  async set(key: string, value: string, opts?: { nx?: boolean; px?: number }) {
    if (this.failing) throw new Error("redis down");
    if (opts?.nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }

  /** Only implements the release script: delete if the value matches. */
  async eval(_script: string, keys: string[], args: string[]) {
    if (this.failing) throw new Error("redis down");
    if (this.store.get(keys[0]) === args[0]) {
      this.store.delete(keys[0]);
      return 1;
    }
    return 0;
  }
}

let fake: FakeRedis | null = new FakeRedis();

vi.mock("@/lib/redis", () => ({
  getRedis: () => fake,
  resetRedisForTests: () => {},
}));

beforeEach(() => {
  fake = new FakeRedis();
});

describe("acquireLock", () => {
  it("excludes a second holder while the first is active", async () => {
    const { acquireLock } = await import("@/lib/lock");

    const first = await acquireLock("k");
    const second = await acquireLock("k");

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("lets the next caller in after release", async () => {
    const { acquireLock, releaseLock } = await import("@/lib/lock");

    const first = await acquireLock("k");
    await releaseLock(first!);

    expect(await acquireLock("k")).not.toBeNull();
  });

  it("issues a distinct token per acquisition", async () => {
    const { acquireLock, releaseLock } = await import("@/lib/lock");

    const a = await acquireLock("k");
    await releaseLock(a!);
    const b = await acquireLock("k");

    expect(a!.token).not.toBe(b!.token);
  });
});

describe("releaseLock", () => {
  it("does not delete a lock now held by someone else", async () => {
    const { acquireLock, releaseLock } = await import("@/lib/lock");

    const stale = await acquireLock("k");
    // Simulate the TTL expiring and a different instance taking the lock.
    fake!.store.set("k", "someone-elses-token");

    await releaseLock(stale!);

    // The newer holder's lock must survive — otherwise an overrunning holder
    // would silently hand the lock to a third party.
    expect(fake!.store.get("k")).toBe("someone-elses-token");
  });
});

describe("degraded operation", () => {
  it("assumes the lock when Redis is not configured", async () => {
    fake = null;
    const { acquireLock, releaseLock } = await import("@/lib/lock");

    const handle = await acquireLock("k");

    // Work must proceed without Redis — a driver must never be blocked from
    // capturing a signature because a cache is missing.
    expect(handle).not.toBeNull();
    expect(handle!.degraded).toBe(true);
    await expect(releaseLock(handle!)).resolves.toBeUndefined();
  });

  it("assumes the lock when Redis throws", async () => {
    fake!.failing = true;
    const { acquireLock } = await import("@/lib/lock");

    const handle = await acquireLock("k");

    expect(handle).not.toBeNull();
    expect(handle!.degraded).toBe(true);
  });

  it("survives a failure during release", async () => {
    const { acquireLock, releaseLock } = await import("@/lib/lock");

    const handle = await acquireLock("k");
    fake!.failing = true;

    // The TTL clears it; a release failure must not propagate.
    await expect(releaseLock(handle!)).resolves.toBeUndefined();
  });
});
