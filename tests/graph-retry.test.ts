/**
 * Graph throttle handling.
 *
 * A 429 means Graph did NOT process the request. Surfacing it as an error made
 * an end-of-day close-out report failure for work that never happened, and made
 * a driver's signature refuse to save during a busy spell. These pin down when
 * a retry happens, how long it waits, and — just as important — when it must
 * not retry at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  graphFetch,
  retryDelayMs,
  MAX_ATTEMPTS,
  MAX_TOTAL_BACKOFF_MS,
} from "@/lib/graph-retry";

/** Response with a Retry-After of zero, so retries are instant in tests. */
const throttled = (headers: Record<string, string> = { "Retry-After": "0" }) =>
  new Response("throttled", { status: 429, headers });

const ok = (body = "ok") => new Response(body, { status: 200 });

let calls: number;

beforeEach(() => {
  calls = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSequence(responses: (() => Response)[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const make = responses[Math.min(calls, responses.length - 1)];
      calls++;
      return make();
    })
  );
}

describe("graphFetch retries", () => {
  it("retries a 429 and returns the eventual success", async () => {
    stubSequence([() => throttled(), () => throttled(), () => ok("done")]);

    const res = await graphFetch("https://graph.microsoft.com/v1.0/me");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("done");
    expect(calls).toBe(3);
  });

  it("retries transient 503 and 504", async () => {
    for (const status of [503, 504]) {
      calls = 0;
      stubSequence([
        () => new Response("x", { status, headers: { "Retry-After": "0" } }),
        () => ok(),
      ]);

      const res = await graphFetch("https://graph.microsoft.com/v1.0/me");
      expect(res.status).toBe(200);
      expect(calls).toBe(2);
    }
  });

  it("does NOT retry a 404 — a missing file is an answer", async () => {
    stubSequence([() => new Response("nope", { status: 404 })]);

    const res = await graphFetch("https://graph.microsoft.com/v1.0/me");

    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("does NOT retry a 401 or 403 — retrying cannot fix authorisation", async () => {
    for (const status of [401, 403, 400]) {
      calls = 0;
      stubSequence([() => new Response("x", { status })]);

      await graphFetch("https://graph.microsoft.com/v1.0/me");
      expect(calls).toBe(1);
    }
  });

  it("gives up after the attempt cap and returns the throttled response", async () => {
    stubSequence([() => throttled()]);

    const res = await graphFetch("https://graph.microsoft.com/v1.0/me");

    // The caller still sees a real Response and handles it as it always did.
    expect(res.status).toBe(429);
    expect(calls).toBe(MAX_ATTEMPTS);
  });

  it("stops early rather than exceeding the backoff budget", async () => {
    // Graph asking for a minute exceeds the whole budget, so we must return
    // immediately instead of blocking the route until it times out.
    stubSequence([() => throttled({ "Retry-After": "60" })]);

    const started = Date.now();
    const res = await graphFetch("https://graph.microsoft.com/v1.0/me");

    expect(res.status).toBe(429);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("replays the request body on retry", async () => {
    const seen: (BodyInit | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(init?.body);
        calls++;
        return calls === 1 ? throttled() : ok();
      })
    );

    await graphFetch("https://graph.microsoft.com/v1.0/upload", {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    });

    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
  });
});

describe("retryDelayMs", () => {
  it("honours Retry-After in seconds", () => {
    const res = new Response("", { status: 429, headers: { "Retry-After": "7" } });
    expect(retryDelayMs(res, 1)).toBe(7000);
  });

  it("honours Retry-After as an HTTP date", () => {
    const when = new Date(Date.now() + 5000).toUTCString();
    const res = new Response("", { status: 429, headers: { "Retry-After": when } });

    const delay = retryDelayMs(res, 1);
    expect(delay).toBeGreaterThan(3000);
    expect(delay).toBeLessThanOrEqual(6000);
  });

  it("treats a past HTTP date as retry-now rather than negative", () => {
    const when = new Date(Date.now() - 60_000).toUTCString();
    const res = new Response("", { status: 429, headers: { "Retry-After": when } });
    expect(retryDelayMs(res, 1)).toBe(0);
  });

  it("backs off exponentially when Graph gives no hint", () => {
    const res = new Response("", { status: 429 });

    const first = retryDelayMs(res, 1);
    const third = retryDelayMs(res, 3);

    expect(first).toBeGreaterThanOrEqual(1000);
    expect(third).toBeGreaterThan(first);
  });

  it("adds jitter so throttled instances do not return in lockstep", () => {
    const res = new Response("", { status: 429 });
    const samples = new Set(Array.from({ length: 25 }, () => retryDelayMs(res, 1)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it("caps the exponential growth", () => {
    const res = new Response("", { status: 429 });
    expect(retryDelayMs(res, 10)).toBeLessThanOrEqual(8000 + 250);
  });

  it("keeps the budget inside the route time limit", () => {
    // maxDuration on the trip-sheet routes is 60s; retrying must not be able
    // to consume it.
    expect(MAX_TOTAL_BACKOFF_MS).toBeLessThan(60_000);
  });
});
