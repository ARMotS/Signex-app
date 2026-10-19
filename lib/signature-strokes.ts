/**
 * A drawn signature as data: strokes of points in CSS pixels, from the top-left
 * of the pad. components/SignaturePad.tsx keeps these alongside the canvas so a
 * re-size (which erases a canvas) never loses the drawing, and renders the PNG
 * it hands over from them rather than from whatever the screen shows.
 *
 * No imports, so the tests run it without a DOM.
 */

export interface Point {
  x: number;
  y: number;
}

export type Stroke = Point[];

/** True when the strokes put any ink down (a tap counts — it is drawn as a dot). */
export function strokeHasInk(strokes: Stroke[]): boolean {
  return strokes.some((s) => s.length > 0);
}

/**
 * The box the ink occupies, padded. Not clipped to the pad: if the box was
 * narrowed after signing (a phone rotated), the whole signature still goes.
 */
export function inkBounds(
  strokes: Stroke[],
  margin: number
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (const p of s) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const x = minX - margin;
  const y = minY - margin;
  return { x, y, width: maxX + margin - x, height: maxY + margin - y };
}

/**
 * The strokes as a PNG data URL, transparent behind the ink, cropped to the
 * ink (so a small signature in a wide pad is not shrunk to nothing when it is
 * fitted into the PDF's box) and drawn at 2× for a crisp print. Browser only.
 */
export function renderSignaturePng(
  strokes: Stroke[],
  opts: { ink: string; lineWidth: number; scale?: number }
): string | null {
  const box = inkBounds(strokes, opts.lineWidth * 4);
  if (!box) return null;
  const scale = opts.scale ?? 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.width * scale);
  canvas.height = Math.ceil(box.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  ctx.strokeStyle = opts.ink;
  ctx.fillStyle = opts.ink;
  ctx.lineWidth = opts.lineWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    if (s.length === 0) continue;
    ctx.beginPath();
    if (s.length === 1) {
      ctx.arc(s[0].x, s[0].y, opts.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.moveTo(s[0].x, s[0].y);
    for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y);
    ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}
