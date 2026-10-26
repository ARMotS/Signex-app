/**
 * How many devices each account may be signed in on, and what a login past
 * that does.
 *
 * For an office account the rule is to ASK, never to silently sign someone
 * else out: past the limit a login is refused until the person confirms. A
 * driver has one phone, so their login always takes the slot. The locked
 * read-decide-write around this, and the per-request revocation check, are
 * covered against a real database in tests/isolation.test.ts.
 */

import { describe, it, expect } from "vitest";
import { planSessionStart, SESSION_LIMITS, hashSessionToken } from "@/lib/session";

describe("SESSION_LIMITS", () => {
  it("is one device for the super admin and a driver, three for a company admin, five for an admin", () => {
    expect(SESSION_LIMITS).toEqual({ super_admin: 1, company_admin: 3, admin: 5, driver: 1 });
  });
});

describe("planSessionStart", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

  it("allows a login below the limit and signs nobody out", () => {
    expect(planSessionStart(ids(4), 5, false)).toEqual({ ok: true, evict: [] });
  });

  it("holds a login at the limit back instead of signing anyone out", () => {
    expect(planSessionStart(ids(5), 5, false)).toEqual({ ok: false, activeSessions: 5 });
  });

  it("signs out only the oldest device once the person confirms", () => {
    expect(planSessionStart(ids(5), 5, true)).toEqual({ ok: true, evict: ["s1"] });
  });

  it("asks a single-device account before taking the slot", () => {
    expect(planSessionStart(ids(1), 1, false)).toEqual({ ok: false, activeSessions: 1 });
    expect(planSessionStart(ids(1), 1, true)).toEqual({ ok: true, evict: ["s1"] });
  });

  it("brings an account that is over a lowered limit back down to it", () => {
    // A super admin signed in on three devices from before the limit was one.
    expect(planSessionStart(ids(3), 1, true)).toEqual({ ok: true, evict: ["s1", "s2", "s3"] });
  });

  it("confirming with a free slot still signs nobody out", () => {
    expect(planSessionStart(ids(2), 5, true)).toEqual({ ok: true, evict: [] });
  });
});

describe("hashSessionToken", () => {
  it("is the hex SHA-256 the migration's backfill also computes", () => {
    expect(hashSessionToken("tok1")).toBe(
      "80b3ad2d438bfafa1ea690c5a59f54548dcc76ad6a839c6704ac1d9d565d9c80"
    );
  });
});
