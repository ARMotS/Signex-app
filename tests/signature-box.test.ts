/**
 * The customer's signature box on a signed invoice: drawn at the size the
 * Settings preview shows, with the label, the signature and "Signed by …"
 * all inside it whatever the box's size or the name's length.
 */

import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import { layoutSignatureBox, signatureBoxRect, type BoxRect } from "@/lib/invoices";
import { drawnWidth } from "@/lib/pdf-measure";

const A4 = { width: 595.28, height: 841.89 };
/** The SignaturePad's canvas: wide and short. */
const PAD_IMAGE = { width: 1200, height: 340 };

async function fonts() {
  const doc = await PDFDocument.create();
  const [font, bold] = await Promise.all([
    doc.embedFont(StandardFonts.Helvetica),
    doc.embedFont(StandardFonts.HelveticaBold),
  ]);
  return { font, bold };
}

function expectInside(box: BoxRect, layout: ReturnType<typeof layoutSignatureBox>, f: { font: PDFFont; bold: PDFFont }) {
  const right = box.x + box.width + 0.01;
  const top = box.y + box.height + 0.01;
  for (const t of layout.texts) {
    const width = drawnWidth(t.bold ? f.bold : f.font, t.text, t.size);
    expect(t.x, t.text).toBeGreaterThanOrEqual(box.x);
    expect(t.x + width, t.text).toBeLessThanOrEqual(right);
    // Helvetica: ascender 0.718, descender 0.207 of the size.
    expect(t.y - t.size * 0.21, t.text).toBeGreaterThanOrEqual(box.y - 0.01);
    expect(t.y + t.size * 0.72, t.text).toBeLessThanOrEqual(top);
  }
  const img = layout.image;
  expect(img.x).toBeGreaterThanOrEqual(box.x);
  expect(img.x + img.width).toBeLessThanOrEqual(right);
  expect(img.y).toBeGreaterThanOrEqual(box.y);
  expect(img.y + img.height).toBeLessThanOrEqual(top);
  expect(layout.rule.start.x).toBeGreaterThanOrEqual(box.x);
  expect(layout.rule.end.x).toBeLessThanOrEqual(right);

  // Nothing overlaps the signature: text is above or below it.
  for (const t of layout.texts) {
    const above = t.y - t.size * 0.21 >= img.y + img.height - 0.01;
    const below = t.y + t.size * 0.72 <= layout.rule.start.y + 0.01;
    expect(above || below, t.text).toBe(true);
  }
}

describe("signatureBoxRect", () => {
  it("is the box the Settings preview draws: w% wide, 0.45·w% of the page high", () => {
    const box = signatureBoxRect({ xPercent: 65, yPercent: 7, widthPercent: 30 }, A4.width, A4.height);
    expect(box.x).toBeCloseTo(A4.width * 0.65);
    expect(box.y).toBeCloseTo(A4.height * 0.07);
    expect(box.width).toBeCloseTo(A4.width * 0.3);
    expect(box.height).toBeCloseTo(A4.height * 0.135);
  });

  it("is pulled back onto the page when the corner would push it off", () => {
    const box = signatureBoxRect({ xPercent: 90, yPercent: 90, widthPercent: 50 }, A4.width, A4.height);
    expect(box.x + box.width).toBeLessThanOrEqual(A4.width);
    expect(box.y + box.height).toBeLessThanOrEqual(A4.height);
    expect(box.width).toBeCloseTo(A4.width * 0.5);
  });
});

describe("layoutSignatureBox", () => {
  const signed = "Signed by Nomvula Precious Mahlangu-Dlamini · 01 Nov 2026, 14:05";
  const notice = "PARTIAL DELIVERY · 3 lines removed — see last page";

  it("keeps every element inside the box at every width Settings allows", async () => {
    const f = await fonts();
    for (const widthPercent of [10, 15, 20, 25, 30, 40, 50]) {
      const box = signatureBoxRect({ xPercent: 40, yPercent: 5, widthPercent }, A4.width, A4.height);
      for (const n of [null, notice]) {
        const layout = layoutSignatureBox(box, { label: "CUSTOMER SIGNATURE", notice: n, signed }, f, PAD_IMAGE);
        expectInside(box, layout, f);
      }
    }
  });

  it("wraps a long name rather than cutting it, in a box of the default size", async () => {
    const f = await fonts();
    const box = signatureBoxRect({ xPercent: 65, yPercent: 7, widthPercent: 30 }, A4.width, A4.height);
    const layout = layoutSignatureBox(box, { label: "CUSTOMER SIGNATURE", notice, signed }, f, PAD_IMAGE);
    const words = (role: string) => layout.texts.filter((t) => t.role === role).map((t) => t.text).join(" ");
    expect(words("signed")).toBe(signed);
    expect(words("notice")).toBe(notice);
    expect(words("label")).toBe("CUSTOMER SIGNATURE");
    expectInside(box, layout, f);
  });

  it("gives the signature most of the box", async () => {
    const f = await fonts();
    const box = signatureBoxRect({ xPercent: 65, yPercent: 7, widthPercent: 30 }, A4.width, A4.height);
    const layout = layoutSignatureBox(box, { label: "CUSTOMER SIGNATURE", notice: null, signed: "Signed by Sam · 01 Nov 2026, 14:05" }, f, PAD_IMAGE);
    // The pad's image is wide, so it fills the width before the height.
    expect(layout.image.width).toBeGreaterThan(box.width * 0.8);
    expect(layout.image.x - box.x).toBeCloseTo(box.x + box.width - (layout.image.x + layout.image.width));
  });

  it("breaks a single word wider than the box", async () => {
    const f = await fonts();
    const box = signatureBoxRect({ xPercent: 65, yPercent: 7, widthPercent: 10 }, A4.width, A4.height);
    const layout = layoutSignatureBox(
      box,
      { label: "CUSTOMER SIGNATURE", notice: null, signed: `Signed by ${"W".repeat(40)} · 01 Nov 2026, 14:05` },
      f,
      PAD_IMAGE
    );
    expectInside(box, layout, f);
  });
});
