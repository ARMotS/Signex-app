/**
 * Rate limiter — the Redis path, and what it costs.
 *
 * Upstash bills per command, so these count commands as well as checking
 * answers: several counters must cost one command, a key already known to be
 * blocked must cost none, and the per-instance budget must never touch Redis.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

/** Interprets the limiter's two scripts and DEL, counting every command. */
class FakeRedis {
  store = new Map<string, { count: number; expiresAt: number | null }>();
  commands = 0;

  private live(key: string) {
    const entry = this.store.get(key);
    if (entry?.expiresAt != null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  private pttl(key: string) {
    const entry = this.live(key);
    if (!entry) return -2;
    return entry.expiresAt == null ? -1 : entry.expiresAt - Date.now();
  }

  async eval(script: string, keys: string[], args: string[]) {
    this.commands++;
    const incr = script.includes("'INCR'");
    const out: number[] = [];
    keys.forEach((key, i) => {
      let entry = this.live(key);
      if (incr) {
        if (!entry) {
          entry = { count: 0, expiresAt: null };
          this.store.set(key, entry);
        }
        entry.count++;
        if (entry.count === 1 || entry.expiresAt == null) {
          entry.expiresAt = Date.now() + Number(args[i]);
        }
        out.push(entry.count, this.pttl(key));
      } else if (!entry) {
        out.push(0, -1);
      } else {
        out.push(entry.count, this.pttl(key));
      }
    });
    return out;
  }

  async del(...keys: string[]) {
    this.commands++;
    for (const key of keys) this.store.delete(key);
    return keys.length;
  }
}

let fake = new FakeRedis();

vi.mock("@/lib/redis", () => ({
  getRedis: () => fake,
  resetRedisForTests: () => {},
}));

const {
  checkRateLimits,
  checkAndRecordRateLimit,
  recordFailedAttempts,
  clearAttemptsFor,
  usesSharedLimit,
} = await import("@/lib/rate-limit");

const SHORT = { maxAttempts: 3, windowMs: 60_000 };

let group: string;
beforeEach(() => {
  fake = new FakeRedis();
  group = `t-${Math.random().toString(36).slice(2)}`;
});

describe("one command for several counters", () => {
  it("peeks two counters in a single command", async () => {
    const [a, b] = await checkRateLimits([
      { identifier: "1.2.3.4", group: `${group}:ip`, config: SHORT },
      { identifier: "jdoe", group: `${group}:user`, config: SHORT },
    ]);
    expect(a.allowed && b.allowed).toBe(true);
    expect(fake.commands).toBe(1);
  });

  it("records a failure against two counters in a single command", async () => {
    const counters = [
      { identifier: "1.2.3.4", group: `${group}:ip`, config: SHORT },
      { identifier: "jdoe", group: `${group}:user`, config: SHORT },
    ];
    await recordFailedAttempts(counters);
    expect(fake.commands).toBe(1);

    const [ip, user] = await checkRateLimits(counters);
    expect(ip.remaining).toBe(2);
    expect(user.remaining).toBe(2);
  });

  it("clears two counters with one DEL, and none with nothing to clear", async () => {
    await clearAttemptsFor([]);
    expect(fake.commands).toBe(0);

    await clearAttemptsFor([
      { identifier: "1.2.3.4", group: `${group}:ip` },
      { identifier: "jdoe", group: `${group}:user` },
    ]);
    expect(fake.commands).toBe(1);
  });
});

describe("blocked keys are answered locally", () => {
  it("costs no command once Redis has said a key is over its limit", async () => {
    for (let i = 0; i < 4; i++) {
      await checkAndRecordRateLimit("alice", group, SHORT);
    }
    const spent = fake.commands;
    expect(spent).toBe(4);

    for (let i = 0; i < 10; i++) {
      const res = await checkAndRecordRateLimit("alice", group, SHORT);
      expect(res.allowed).toBe(false);
      expect(res.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(fake.commands).toBe(spent);
  });

  it("asks Redis again once the window has reset", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 4; i++) await checkAndRecordRateLimit("bob", group, SHORT);
      vi.advanceTimersByTime(SHORT.windowMs + 1000);

      const res = await checkAndRecordRateLimit("bob", group, SHORT);
      expect(res.allowed).toBe(true);
      expect(fake.commands).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still records a failure for a blocked key", async () => {
    // The cache answers checks; it must not stand in for the record, or a
    // lockout would stop counting the guesses that keep it in place.
    const counter = { identifier: "carol", group, config: SHORT };
    for (let i = 0; i < 4; i++) await recordFailedAttempts([counter]);
    const before = fake.commands;
    await recordFailedAttempts([counter]);
    expect(fake.commands).toBe(before + 1);
  });

  it("forgets a block when the counter is cleared", async () => {
    const counter = { identifier: "dave", group, config: SHORT };
    for (let i = 0; i < 4; i++) await recordFailedAttempts([counter]);
    expect((await checkRateLimits([counter]))[0].allowed).toBe(false);

    await clearAttemptsFor([counter]);
    expect((await checkRateLimits([counter]))[0].allowed).toBe(true);
  });
});

describe("every key expires", () => {
  it("gives a counter found without an expiry one, so it cannot lock out forever", async () => {
    const key = `rl:${group}:erin`;
    fake.store.set(key, { count: 7, expiresAt: null });

    await checkAndRecordRateLimit("erin", group, SHORT);
    expect(fake.store.get(key)?.expiresAt).not.toBeNull();
  });
});

describe("the per-instance budget", () => {
  it("never calls Redis", async () => {
    for (let i = 0; i < 5; i++) {
      await checkAndRecordRateLimit("frank", group, SHORT, { shared: false });
    }
    expect(fake.commands).toBe(0);
    expect(
      (await checkAndRecordRateLimit("frank", group, SHORT, { shared: false })).allowed
    ).toBe(false);
  });
});

describe("which requests keep the shared budget", () => {
  it("covers uploads and the requests that parse PDFs or sheets", () => {
    for (const [method, path] of [
      ["POST", "/api/invoices/upload"],
      ["POST", "/api/trip-sheet"],
      ["POST", "/api/trip-sheet/folder"],
      ["POST", "/api/contacts/import"],
      ["POST", "/api/courier"],
      ["POST", "/api/courier/inbox"],
      ["POST", "/api/credit-notes"],
      ["POST", "/api/credit-notes/sync"],
      ["PUT", "/api/credit-notes/abc"],
      ["POST", "/api/collections/abc/sheet"],
      ["PUT", "/api/collections/abc/sheet"],
      ["POST", "/api/import-templates/preview"],
    ]) {
      expect(usesSharedLimit(method, path), `${method} ${path}`).toBe(true);
    }
  });

  it("leaves list reads and polls on the instance", () => {
    for (const [method, path] of [
      ["GET", "/api/sync"],
      ["GET", "/api/auth/session"],
      ["GET", "/api/courier"],
      ["GET", "/api/credit-notes"],
      ["GET", "/api/trip-sheet"],
      ["GET", "/api/invoices/upload"],
      ["GET", "/api/courier/attention"],
      ["PUT", "/api/collections/abc"],
      ["POST", "/api/credit-notes/abc/sign"],
    ]) {
      expect(usesSharedLimit(method, path), `${method} ${path}`).toBe(false);
    }
  });
});
