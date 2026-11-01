/**
 * courier-stamp.ts
 * Draws the courier handover onto an invoice: on the last page in the
 * configured area when nothing is printed there, otherwise on a page added
 * at the end — never over the invoice's own print.
 *
 * Whether the area is clear is read from the PDF's text layer (the same
 * reader as the invoice header). A scanned invoice has no text layer and so
 * always reads clear — the stamp's white box keeps it legible over the scan.
 */

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { extractPageItems, type TextItem } from "./invoice-header";
import type { StampArea, StampLines } from "./courier-stamp-text";
import { drawnWidth } from "./pdf-measure";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The area as points on a page of this size (origin bottom-left). */
export function areaRect(area: StampArea, pageWidth: number, pageHeight: number): Rect {
  return {
    x: (area.xPercent / 100) * pageWidth,
    y: (area.yPercent / 100) * pageHeight,
    width: (area.widthPercent / 100) * pageWidth,
    height: (area.heightPercent / 100) * pageHeight,
  };
}

/**
 * Whether no printed text falls in the rectangle. pdf.js-extract measures y
 * down from the top of the page, and accounts differ on whether it is the
 * top or the baseline — so each item is taken to span a full height either
 * side of its y. Erring towards "not clear" only costs an extra page.
 */
export function rectIsClear(items: TextItem[], pageHeight: number, rect: Rect): boolean {
  const top = pageHeight - (rect.y + rect.height);
  const bottom = pageHeight - rect.y;
  return !items.some((item) => {
    if (!item.str.trim()) return false;
    const h = item.height || 10;
    const overlapsX = item.x < rect.x + rect.width && item.x + (item.width || 0) > rect.x;
    const overlapsY = item.y - h < bottom && item.y + h > top;
    return overlapsX && overlapsY;
  });
}

/** Helvetica encodes Latin-1 only; drawText throws on anything else. */
const safe = (text: string) =>
  String(text ?? "")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Shrink to fit the width, then cut — a long name never runs off the box. */
function fitted(font: PDFFont, text: string, size: number, maxWidth: number): { text: string; size: number } {
  let s = size;
  while (s > 6 && drawnWidth(font, text, s) > maxWidth) s -= 0.5;
  let t = text;
  while (t.length > 1 && drawnWidth(font, t, s) > maxWidth) t = t.slice(0, -2) + "…";
  return { text: t, size: s };
}

function drawBlock(page: PDFPage, rect: Rect, lines: StampLines, signature: PDFImage, font: PDFFont, bold: PDFFont) {
  const ink = rgb(0.08, 0.08, 0.08);
  const muted = rgb(0.4, 0.4, 0.4);
  const pad = 6;
  const inner = rect.width - pad * 2;

  page.drawRectangle({
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.78, 0.76, 0.72),
    borderWidth: 0.6,
  });

  const size = Math.min(8.5, Math.max(6.5, rect.height / 13));
  let y = rect.y + rect.height - pad - size;
  for (const [text, f] of [
    [lines.dispatched, font],
    [lines.collected, bold],
  ] as const) {
    const fit = fitted(f, safe(text), size, inner);
    page.drawText(fit.text, { x: rect.x + pad, y, size: fit.size, font: f, color: ink });
    y -= size + 3;
  }

  // The rule the signature sits on, then the footer at the bottom.
  const footerSize = Math.max(6.5, size - 0.5);
  const footerY = rect.y + pad;
  const ruleY = footerY + footerSize + 4;
  const sigTop = y - 2;
  const sigHeight = Math.max(10, sigTop - ruleY - 2);
  const scale = Math.min(inner / signature.width, sigHeight / signature.height, 1);
  const w = signature.width * scale;
  const h = signature.height * scale;
  page.drawImage(signature, { x: rect.x + (rect.width - w) / 2, y: ruleY + 1, width: w, height: h });
  page.drawLine({
    start: { x: rect.x + pad, y: ruleY },
    end: { x: rect.x + rect.width - pad, y: ruleY },
    thickness: 0.6,
    color: rgb(0.55, 0.55, 0.55),
  });
  drawFooter(page, rect.x + pad, footerY, inner, lines, footerSize, font, bold, ink, muted);
}

/**
 * The footer, centred: its labels in grey, the courier sheet and waybill
 * numbers in bold ink. Shrinks to fit; if the waybills are still too long at
 * the smallest size, the last number is cut with an ellipsis.
 */
function drawFooter(
  page: PDFPage,
  x: number,
  y: number,
  width: number,
  lines: StampLines,
  size: number,
  font: PDFFont,
  bold: PDFFont,
  ink: ReturnType<typeof rgb>,
  muted: ReturnType<typeof rgb>
) {
  // safe() trims, so only the numbers go through it: the labels' own spaces
  // are part of the line. An em dash is drawable (WinAnsi), so it stands in
  // for a number that had nothing printable.
  const parts = lines.footerParts.map((p) => ({
    ...p,
    text: p.bold ? safe(p.text) || "—" : p.text.replace(/[^\x20-\x7E\xA0-\xFF]/g, ""),
  }));
  const total = (s: number) => parts.reduce((w, p) => w + drawnWidth(p.bold ? bold : font, p.text, s), 0);

  let s = size;
  while (s > 5.5 && total(s) > width) s -= 0.5;
  const last = parts[parts.length - 1];
  while (total(s) > width && last.text.length > 1) last.text = `${last.text.slice(0, -2)}…`;

  let cx = x + (width - total(s)) / 2;
  for (const p of parts) {
    const f = p.bold ? bold : font;
    page.drawText(p.text, { x: cx, y, size: s, font: f, color: p.bold ? ink : muted });
    cx += drawnWidth(f, p.text, s);
  }
}

/**
 * The invoice with the handover stamped on it. `appended` says the stamp went
 * on an added page because the area on the last page was not clear (or the
 * page could not be read).
 */
export async function stampCourierHandover(
  pdfBytes: Buffer,
  stamp: { lines: StampLines; signaturePng: Uint8Array; area: StampArea }
): Promise<{ pdf: Buffer; appended: boolean }> {
  const doc = await PDFDocument.load(pdfBytes);
  const pages = doc.getPages();
  const last = pages[pages.length - 1];
  const { width, height } = last.getSize();
  let rect = areaRect(stamp.area, width, height);

  let clear = false;
  try {
    const items = await extractPageItems(pdfBytes);
    clear = rectIsClear(items[items.length - 1] ?? [], height, rect);
  } catch {
    clear = false;
  }

  let page = last;
  if (!clear) {
    // A4, the block at the top of the page under a heading.
    page = doc.addPage([595.28, 841.89]);
    const margin = 56;
    rect = { x: margin, y: 841.89 - margin - 30 - 150, width: 595.28 - margin * 2, height: 150 };
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    page.drawText("COURIER HANDOVER", { x: margin, y: 841.89 - margin - 14, size: 14, font: bold, color: rgb(0.08, 0.08, 0.08) });
  }

  const [font, bold, signature] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
    doc.embedPng(stamp.signaturePng),
  ]);
  drawBlock(page, rect, stamp.lines, signature, font, bold);

  return { pdf: Buffer.from(await doc.save()), appended: !clear };
}

/** The PNG inside a data URL, or null when it is not one. */
export function pngFromDataUrl(dataUrl: string): Uint8Array | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
  if (!m) return null;
  const bytes = Buffer.from(m[1], "base64");
  // The PNG signature, so a mislabelled payload fails here rather than in pdf-lib.
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    ? new Uint8Array(bytes)
    : null;
}
