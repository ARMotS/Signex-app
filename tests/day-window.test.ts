/**
 * The "today" boundary used by the dashboard and the Completed Today tab.
 *
 * These are the cases that actually bite: a depot two hours ahead of UTC
 * signing for a delivery at 07:00 local, which is still yesterday in UTC.
 */

import { describe, it, expect } from "vitest";
import { dayWindow, parseTzOffset } from "@/lib/day-window";

describe("parseTzOffset", () => {
  it("defaults to UTC when the parameter is missing or unusable", () => {
    expect(parseTzOffset(null)).toBe(0);
    expect(parseTzOffset(undefined)).toBe(0);
    expect(parseTzOffset("")).toBe(0);
    expect(parseTzOffset("not-a-number")).toBe(0);
    expect(parseTzOffset("NaN")).toBe(0);
  });

  it("accepts the value getTimezoneOffset() produces", () => {
    // UTC+2 (Johannesburg) reports -120.
    expect(parseTzOffset("-120")).toBe(-120);
    // UTC-5 reports 300.
    expect(parseTzOffset("300")).toBe(300);
  });

  it("clamps beyond the range of any real timezone", () => {
    expect(parseTzOffset("99999")).toBe(14 * 60);
    expect(parseTzOffset("-99999")).toBe(-14 * 60);
  });
});

describe("dayWindow", () => {
  it("spans exactly one day", () => {
    const { start, end } = dayWindow(new Date("2026-08-16T09:30:00.000Z"), -120);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("cuts the day at local midnight, not UTC midnight", () => {
    // 07:00 UTC is 09:00 in UTC+2 — the same local day either way.
    const { start } = dayWindow(new Date("2026-08-16T07:00:00.000Z"), -120);
    // Local midnight on the 16th is 22:00 UTC on the 15th.
    expect(start.toISOString()).toBe("2026-08-15T22:00:00.000Z");
  });

  it("keeps an early-morning delivery in the local day it happened on", () => {
    // 05:00 local in UTC+2 is 03:00 UTC on the same date, but the window must
    // still be the local day — this is the case a naive UTC midnight gets right
    // by accident and the next one gets wrong.
    const signedAt = new Date("2026-08-16T03:00:00.000Z"); // 05:00 local
    const { start, end } = dayWindow(signedAt, -120);
    expect(signedAt >= start && signedAt < end).toBe(true);
  });

  it("files a late-evening UTC timestamp under the correct local day", () => {
    // 23:00 UTC on the 15th is 01:00 local on the 16th in UTC+2. A dispatcher
    // looking at the 16th must see it; a UTC-midnight window would not.
    const signedAt = new Date("2026-08-15T23:00:00.000Z");
    const viewedAt = new Date("2026-08-16T08:00:00.000Z"); // 10:00 local, 16th
    const { start, end } = dayWindow(viewedAt, -120);
    expect(signedAt >= start && signedAt < end).toBe(true);
  });

  it("excludes yesterday", () => {
    const viewedAt = new Date("2026-08-16T08:00:00.000Z");
    const { start } = dayWindow(viewedAt, -120);
    const yesterday = new Date("2026-08-14T23:00:00.000Z");
    expect(yesterday < start).toBe(true);
  });

  it("works west of UTC too", () => {
    // UTC-5 reports +300. 02:00 UTC on the 16th is 21:00 local on the 15th.
    const { start, end } = dayWindow(new Date("2026-08-16T02:00:00.000Z"), 300);
    expect(start.toISOString()).toBe("2026-08-15T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-16T05:00:00.000Z");
  });

  it("falls back to UTC for an absent offset", () => {
    const { start, end } = dayWindow(new Date("2026-08-16T13:45:00.000Z"));
    expect(start.toISOString()).toBe("2026-08-16T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });

  it("clamps an absurd offset rather than producing a nonsense window", () => {
    const { offsetMinutes } = dayWindow(new Date("2026-08-16T13:45:00.000Z"), 1e9);
    expect(offsetMinutes).toBe(14 * 60);
  });
});
