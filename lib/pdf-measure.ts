/**
 * The width pdf-lib will actually DRAW a string at, in points.
 *
 * `PDFFont.widthOfTextAtSize` subtracts kerning pairs ("W,", "AV" …), but
 * `drawText` writes a plain string with no kerning adjustments, so the drawn
 * run is wider than measured — a waybill list full of "WB" ran ~11pt past the
 * box it had been "fitted" to. Summing glyph by glyph measures what is drawn.
 */
export function drawnWidth(
  font: { widthOfTextAtSize: (text: string, size: number) => number },
  text: string,
  size: number
): number {
  let width = 0;
  for (const ch of text) width += font.widthOfTextAtSize(ch, size);
  return width;
}
