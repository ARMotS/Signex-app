/**
 * How many devices an ADMIN may be signed in on, and what a 4th login does.
 *
 * The rule is to ASK, never to silently sign someone else out: past the limit
 * a login is refused until the person confirms. Expired sessions must not
 * count, or a browser that was simply closed would hold a slot for good.
 * The locked read-decide-write around this is covered against a real database
 * in tests/isolation.test.ts.
 */

import { describe, it, expect } from "vitest";
import { planAdminSession, isSessionTokenLive, MAX_ADMIN_SESSIONS } from "@/lib/session";

const NOW = Date.UTC(2026, 9, 13, 12);
const HOUR = 3_600_000;
const tokenAt = (ms: number, tag = "x") => `${ms.toString(36)}.${tag}`;

describe("isSessionTokenLive", () => {
  it("is live within the 24h cookie lifetime", () => {
    expect(isSessionTokenLive(tokenAt(NOW - 23 * HOUR), NOW)).toBe(true);
  });

  it("is dead once the cookie it was issued with has expired", () => {
    expect(isSessionTokenLive(tokenAt(NOW - 25 * HOUR), NOW)).toBe(false);
  });

  it("treats a pre-timestamp token as live — its age is unknown", () => {
    expect(isSessionTokenLive("a".repeat(64), NOW)).toBe(true);
  });

  it("treats an unparseable issue time as dead", () => {
    expect(isSessionTokenLive("!!.abc", NOW)).toBe(false);
  });
});

describe("planAdminSession", () => {
  const live = (n: number) => Array.from({ length: n }, (_, i) => tokenAt(NOW - (n - i) * HOUR, `d${i + 1}`));

  it("allows three devices", () => {
    expect(MAX_ADMIN_SESSIONS).toBe(3);
    const plan = planAdminSession(live(2), "new", false, NOW);
    expect(plan).toEqual({ ok: true, tokens: [...live(2), "new"] });
  });

  it("holds a 4th login back instead of signing anyone out", () => {
    expect(planAdminSession(live(3), "new", false, NOW)).toEqual({ ok: false, activeSessions: 3 });
  });

  it("signs out only the oldest device once the person confirms", () => {
    const current = live(3);
    expect(planAdminSession(current, "new", true, NOW)).toEqual({
      ok: true,
      tokens: [current[1], current[2], "new"],
    });
  });

  it("does not count expired sessions, so no prompt is needed", () => {
    const current = [tokenAt(NOW - 30 * HOUR, "stale"), ...live(2)];
    expect(planAdminSession(current, "new", false, NOW)).toEqual({
      ok: true,
      tokens: [...live(2), "new"],
    });
  });
});
