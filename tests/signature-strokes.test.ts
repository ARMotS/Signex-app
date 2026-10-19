import { describe, it, expect } from "vitest";
import { inkBounds, strokeHasInk } from "@/lib/signature-strokes";

describe("a drawn signature as strokes", () => {
  it("counts a tap as ink, and nothing as none", () => {
    expect(strokeHasInk([])).toBe(false);
    expect(strokeHasInk([[]])).toBe(false);
    expect(strokeHasInk([[{ x: 4, y: 4 }]])).toBe(true);
  });

  it("crops to the ink with a margin, never to the pad", () => {
    const strokes = [
      [{ x: 40, y: 50 }, { x: 120, y: 30 }],
      [{ x: 300, y: 90 }], // beyond a pad since narrowed to 260px
    ];
    expect(inkBounds(strokes, 10)).toEqual({ x: 30, y: 20, width: 280, height: 80 });
    expect(inkBounds([], 10)).toBeNull();
  });
});
