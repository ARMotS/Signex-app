import { describe, it, expect } from "vitest";
import { relativeTime } from "@/lib/relative-time";

describe("relativeTime", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");
  const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();

  it("says never for no time at all, in the caller's words", () => {
    expect(relativeTime(null, "Never", now)).toBe("Never");
    expect(relativeTime(null, "Never signed in", now)).toBe("Never signed in");
  });

  it("reads minutes and hours, then yesterday, then a date", () => {
    expect(relativeTime(ago(1), "Never", now)).toBe("Just now");
    expect(relativeTime(ago(4), "Never", now)).toBe("4 min ago");
    expect(relativeTime(ago(180), "Never", now)).toBe("3 h ago");
    expect(relativeTime(ago(30 * 60), "Never", now)).toMatch(/^Yesterday /);
    expect(relativeTime(ago(5 * 24 * 60), "Never", now)).toMatch(/2026/);
  });
});
