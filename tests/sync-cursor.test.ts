/**
 * Change-feed cursor rules.
 *
 * The whole point of the cursor is that a client can trust "unchanged cursor
 * means unchanged data". These pin down the cases a naive MAX(updatedAt) cursor
 * gets wrong — every one of them is a real sequence: an admin completing a
 * sheet, a driver signing a stop, a sheet being deleted at day's end.
 */

import { describe, it, expect } from "vitest";
import { formatCursor } from "@/lib/sync-cursor";

const at = (iso: string) => new Date(iso);
const stamp = (max: Date | null, count: number) => ({ max, count });

describe("formatCursor", () => {
  it("is stable for identical state", () => {
    const a = formatCursor(stamp(at("2026-08-01T09:00:00Z"), 3), stamp(at("2026-08-01T09:30:00Z"), 40));
    const b = formatCursor(stamp(at("2026-08-01T09:00:00Z"), 3), stamp(at("2026-08-01T09:30:00Z"), 40));
    expect(a).toBe(b);
  });

  it("moves when a stop is signed (updatedAt advances)", () => {
    const before = formatCursor(stamp(at("2026-08-01T09:00:00Z"), 3), stamp(at("2026-08-01T09:30:00Z"), 40));
    const after = formatCursor(stamp(at("2026-08-01T09:00:00Z"), 3), stamp(at("2026-08-01T09:31:00Z"), 40));
    expect(after).not.toBe(before);
  });

  it("moves when a new trip sheet is deployed", () => {
    const before = formatCursor(stamp(at("2026-08-01T09:00:00Z"), 3), stamp(at("2026-08-01T09:30:00Z"), 40));
    const after = formatCursor(stamp(at("2026-08-01T10:00:00Z"), 4), stamp(at("2026-08-01T10:00:00Z"), 52));
    expect(after).not.toBe(before);
  });

  it("moves when rows are DELETED even though no timestamp advances", () => {
    // The case a timestamp-only cursor misses: completing a trip sheet removes
    // it and cascades its stops, without advancing anything.
    const before = formatCursor(stamp(at("2026-08-01T09:00:00Z"), 3), stamp(at("2026-08-01T09:30:00Z"), 40));
    const after = formatCursor(stamp(at("2026-08-01T09:00:00Z"), 2), stamp(at("2026-08-01T09:30:00Z"), 28));
    expect(after).not.toBe(before);
  });

  it("moves when the NEWEST row is deleted and the maximum goes backwards", () => {
    // Deleting the most recently touched row lowers MAX(updatedAt). A cursor
    // that only tracked "has the maximum advanced" would conclude nothing
    // happened; the count is what catches it.
    const before = formatCursor(stamp(at("2026-08-01T09:00:00Z"), 3), stamp(at("2026-08-01T09:30:00Z"), 40));
    const after = formatCursor(stamp(at("2026-08-01T08:00:00Z"), 2), stamp(at("2026-08-01T09:00:00Z"), 30));
    expect(after).not.toBe(before);
  });

  it("distinguishes a change in stops from a change in trip sheets", () => {
    const base = stamp(at("2026-08-01T09:00:00Z"), 3);
    const sheetsChanged = formatCursor(stamp(at("2026-08-01T09:05:00Z"), 3), stamp(at("2026-08-01T09:30:00Z"), 40));
    const stopsChanged = formatCursor(base, stamp(at("2026-08-01T09:35:00Z"), 40));
    expect(sheetsChanged).not.toBe(stopsChanged);
  });

  it("does not collide when a count and a timestamp trade places", () => {
    // Guards against a delimiter-free format where "12" + "3" and "1" + "23"
    // would produce the same string.
    const a = formatCursor(stamp(new Date(12), 3), stamp(new Date(0), 0));
    const b = formatCursor(stamp(new Date(1), 23), stamp(new Date(0), 0));
    expect(a).not.toBe(b);
  });

  it("handles an empty scope without throwing", () => {
    const empty = formatCursor(stamp(null, 0), stamp(null, 0));
    expect(typeof empty).toBe("string");
    expect(empty.length).toBeGreaterThan(0);
  });

  it("moves as soon as the first trip sheet lands in an empty scope", () => {
    const empty = formatCursor(stamp(null, 0), stamp(null, 0));
    const first = formatCursor(stamp(at("2026-08-01T06:00:00Z"), 1), stamp(at("2026-08-01T06:00:00Z"), 12));
    expect(first).not.toBe(empty);
  });
});
