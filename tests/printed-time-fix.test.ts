/**
 * Correcting the UTC times already printed on filed documents
 * (lib/printed-time-fix.ts). The PDFs here are drawn the way the old code drew
 * them — pdf-lib drawText, Helvetica — and read back with pdf.js-extract, the
 * same reader the app uses, so the test checks the text a person would see.
 */

import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { correctPrintedTimes, formatUtcStamp, signedInstantOf } from "@/lib/printed-time-fix";
import { extractPageItems } from "@/lib/invoice-header";
import { buildSignedCollectionPdf } from "@/lib/collections";

/** 09:35 SAST on 19 Nov 2026 — printed by the old code as 07:35. */
const SIGNED = new Date("2026-11-19T07:35:12.345Z");

async function pdfWith(lines: string[][], subject?: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const pageLines of lines) {
    const page = doc.addPage([595, 842]);
    pageLines.forEach((text, i) => page.drawText(text, { x: 40, y: 800 - i * 14, size: 8, font: i === 0 ? bold : font }));
  }
  if (subject) doc.setSubject(subject);
  return Buffer.from(await doc.save());
}

async function textOf(pdf: Buffer): Promise<string[][]> {
  return (await extractPageItems(pdf)).map((items) => items.map((i) => i.str).filter((t) => t.trim() !== ""));
}

/** x positions of every text run, to prove nothing moved. */
async function xsOf(pdf: Buffer): Promise<number[]> {
  return (await extractPageItems(pdf)).flat().filter((i) => i.str.trim() !== "").map((i) => Math.round((i.x + i.width) * 100) / 100);
}

describe("formatUtcStamp", () => {
  it("is what the old code printed on a UTC server", () => {
    expect(formatUtcStamp(SIGNED)).toBe("19 Nov 2026, 07:35");
    expect(
      SIGNED.toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })
    ).toBe("19 Nov 2026, 07:35");
  });
});

describe("correctPrintedTimes", () => {
  it("moves a signed invoice's time to SA time, and only the digits", async () => {
    const pdf = await pdfWith(
      [["CUSTOMER SIGNATURE", "Signed by Thabo Nkosi · 19 Nov 2026, 07:35"]],
      `Signed:${SIGNED.toISOString()}`
    );
    const at = await signedInstantOf(pdf);
    expect(at?.toISOString()).toBe(SIGNED.toISOString());

    const r = await correctPrintedTimes(pdf, [at!]);
    expect(r.fixed).toEqual(["19 Nov 2026, 07:35 → 19 Nov 2026, 09:35"]);
    expect(await textOf(r.pdf!)).toEqual([["CUSTOMER SIGNATURE", "Signed by Thabo Nkosi · 19 Nov 2026, 09:35"]]);
    expect(await xsOf(r.pdf!)).toEqual(await xsOf(pdf));
  });

  it("follows a time wrapped onto the next line, and the exceptions page", async () => {
    const pdf = await pdfWith([
      ["CUSTOMER SIGNATURE", "Signed by Bongani Mthembu-Van der Merwe · 19 Nov", "2026, 07:35"],
      ["DELIVERY EXCEPTIONS", "Signed by Bongani Mthembu-Van der Merwe · 19 Nov 2026, 07:35"],
    ]);
    const r = await correctPrintedTimes(pdf, [SIGNED]);
    expect(r.fixed).toHaveLength(2);
    expect(await textOf(r.pdf!)).toEqual([
      ["CUSTOMER SIGNATURE", "Signed by Bongani Mthembu-Van der Merwe · 19 Nov", "2026, 09:35"],
      ["DELIVERY EXCEPTIONS", "Signed by Bongani Mthembu-Van der Merwe · 19 Nov 2026, 09:35"],
    ]);
  });

  it("rolls the day over at SA midnight", async () => {
    const late = new Date("2026-11-19T22:40:00Z"); // 00:40 on the 20th in SA
    const r = await correctPrintedTimes(await pdfWith([["Date / time", "19 Nov 2026, 22:40"]]), [late]);
    expect(await textOf(r.pdf!)).toEqual([["Date / time", "20 Nov 2026, 00:40"]]);
  });

  it("leaves a month roll-over for a person (the line's width would change)", async () => {
    const late = new Date("2026-11-30T23:10:00Z"); // 01:10 on 1 Dec in SA
    const r = await correctPrintedTimes(await pdfWith([["Date / time", "30 Nov 2026, 23:10"]]), [late]);
    expect(r.pdf).toBeNull();
    expect(r.manual).toEqual(["30 Nov 2026, 23:10 → 01 Dec 2026, 01:10"]);
  });

  it("is a no-op on a corrected file, so it can run twice", async () => {
    const pdf = await pdfWith([["CUSTOMER SIGNATURE", "Signed by Thabo · 19 Nov 2026, 07:35"]]);
    const once = await correctPrintedTimes(pdf, [SIGNED]);
    const twice = await correctPrintedTimes(once.pdf!, [SIGNED]);
    expect(twice.pdf).toBeNull();
    expect(twice.alreadyRight).toBe(1);
    expect(twice.fixed).toEqual([]);
  });

  it("never touches a time it cannot account for", async () => {
    // An invoice's own printed time, and a time two hours off another instant.
    const pdf = await pdfWith([["INVOICE", "Printed 19 Nov 2026, 06:02", "Signed by Thabo · 19 Nov 2026, 07:35"]]);
    const r = await correctPrintedTimes(pdf, [new Date("2026-11-19T05:35:00Z")]);
    expect(r.pdf).toBeNull();
    expect(r.unexplained).toEqual(["19 Nov 2026, 06:02"]);
    // 07:35 is SA time for 05:35Z — read as already right, never shifted again.
    expect(r.alreadyRight).toBe(1);
  });

  it("does nothing with no instants", async () => {
    const r = await correctPrintedTimes(await pdfWith([["Signed · 19 Nov 2026, 07:35"]]), []);
    expect(r.pdf).toBeNull();
    expect(r.unexplained).toEqual(["19 Nov 2026, 07:35"]);
  });

  it("finds today's receipts already right", async () => {
    const receipt = await buildSignedCollectionPdf(null, {
      collectionNo: "1797",
      type: "CREDIT_RETURN",
      upliftSubtype: null,
      originalInvoiceNo: "644690",
      status: "NOT_AVAILABLE",
      expectedQty: 2,
      collectedQty: null,
      exceptionReason: "Shop closed",
      notes: null,
      customerName: "Example Customer",
      signedByName: null,
      driverName: "Driver One",
      collectedAt: SIGNED,
      lines: [],
      declaration: "",
    } as Parameters<typeof buildSignedCollectionPdf>[1]);
    const r = await correctPrintedTimes(receipt, [SIGNED]);
    expect(r.pdf).toBeNull();
    expect(r.alreadyRight).toBeGreaterThanOrEqual(1);
    expect(r.fixed).toEqual([]);
  });
});
