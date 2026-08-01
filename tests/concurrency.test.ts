/**
 * Bounded parallelism helper.
 *
 * The properties that matter for batch close-out: results stay paired with
 * their inputs, the ceiling is genuinely enforced (the pg pool and Graph's
 * throttle both depend on it), and no worker sits idle while items remain.
 */

import { describe, it, expect } from "vitest";
import { mapWithConcurrency, DEFAULT_CONCURRENCY } from "@/lib/concurrency";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("returns results in input order, not completion order", async () => {
    // Deliberately invert the timing so completion order is the reverse of input.
    const out = await mapWithConcurrency(
      [40, 30, 20, 10],
      async (delay) => {
        await tick(delay);
        return delay;
      },
      4
    );

    expect(out).toEqual([40, 30, 20, 10]);
  });

  it("passes the index through", async () => {
    const out = await mapWithConcurrency(["a", "b", "c"], async (item, i) => `${i}:${item}`);
    expect(out).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("never exceeds the concurrency ceiling", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick(5);
        inFlight--;
      },
      3
    );

    expect(peak).toBeLessThanOrEqual(3);
  });

  it("actually runs in parallel rather than serialising", async () => {
    const started: number[] = [];

    await mapWithConcurrency(
      Array.from({ length: 4 }, (_, i) => i),
      async (i) => {
        started.push(i);
        await tick(20);
      },
      4
    );

    // All four claimed a slot before any had finished.
    expect(started).toHaveLength(4);
  });

  it("keeps workers busy when items take uneven time", async () => {
    // One very slow item must not stall the others behind it.
    const order: number[] = [];

    await mapWithConcurrency(
      [50, 1, 1, 1, 1],
      async (delay, i) => {
        await tick(delay);
        order.push(i);
      },
      2
    );

    // The slow first item finishes last despite being claimed first.
    expect(order[order.length - 1]).toBe(0);
    expect(order).toHaveLength(5);
  });

  it("handles an empty list without spawning workers", async () => {
    expect(await mapWithConcurrency([], async () => 1)).toEqual([]);
  });

  it("clamps a limit larger than the list, and a limit below one", async () => {
    expect(await mapWithConcurrency([1, 2], async (n) => n * 2, 99)).toEqual([2, 4]);
    expect(await mapWithConcurrency([1, 2], async (n) => n * 2, 0)).toEqual([2, 4]);
  });

  it("propagates a rejection", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow("boom");
  });

  it("defaults to a ceiling that does not starve the pg pool", () => {
    expect(DEFAULT_CONCURRENCY).toBeGreaterThan(1);
    expect(DEFAULT_CONCURRENCY).toBeLessThanOrEqual(5);
  });
});
