/**
 * Reading an invoice's date and customer off the PDF text layer.
 *
 * The fixture is drawn to the layout of the client's real invoice (IV-634573):
 * a row of labels with the values on the row under it, Order date and Invoice
 * date side by side and equal, and "Invoice to" (a cash account) beside
 * "Deliver to" (the real customer). It goes through pdf.js exactly as a
 * production PDF does — positions, word splitting and all.
 */

import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import {
  extractFirstPageItems,
  parseInvoiceDate,
  readHeaderFromItems,
} from "@/lib/invoice-header";

const HEIGHT = 842;

/** Draw at a top-left y, the way the invoice is laid out on screen. */
function text(page: PDFPage, font: PDFFont, s: string, x: number, top: number, size = 8) {
  page.drawText(s, { x, y: HEIGHT - top - size, size, font });
}

async function electroCityInvoice(opts: { orderDate?: string; invoiceDate?: string } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, HEIGHT]);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const bold = await doc.embedFont(StandardFonts.CourierBold);

  text(page, bold, "ELECTRO CITY cc", 30, 30, 12);
  text(page, bold, "TAX INVOICE", 80, 150, 11);
  text(page, bold, "634573", 230, 150, 11);
  text(page, bold, "Customer VAT no 4120220969", 340, 150, 9);

  text(page, bold, "Invoice to:", 50, 172);
  text(page, mono, "CASH SALES JHB", 52, 184);
  text(page, mono, "OVER THE COUNTER", 52, 194);
  text(page, bold, "Deliver to:", 350, 172);
  text(page, mono, "ATLANTIC AUTO SPARES(LANGLAAG)", 352, 184);
  text(page, mono, "c/o DE VOS & ALBERTINA SISULU", 352, 194);

  text(page, bold, "Account no", 22, 262, 7);
  text(page, bold, "Order no", 115, 262, 7);
  text(page, bold, "Order date", 255, 262, 7);
  text(page, bold, "Branch", 435, 259, 8);
  text(page, bold, "Invoice date", 500, 262, 7);
  text(page, mono, "A136", 22, 276, 9);
  text(page, mono, "waseem", 115, 276, 9);
  text(page, mono, opts.orderDate ?? "14/10/2026", 255, 276, 9);
  text(page, bold, "J1", 445, 276, 9);
  text(page, mono, opts.invoiceDate ?? "14/10/2026", 500, 276, 9);

  text(page, bold, "Product no", 22, 305, 7);
  text(page, bold, "Description", 250, 305, 7);
  text(page, mono, "220788", 15, 325, 9);
  text(page, mono, "30A MINI FUSE FEMALE", 250, 325, 7);

  return Buffer.from(await doc.save());
}

describe("reading the client's invoice header", () => {
  it("reads the invoice date, deliver-to and invoice-to", async () => {
    const items = await extractFirstPageItems(await electroCityInvoice());
    const header = readHeaderFromItems(items);

    expect(header.invoiceDate?.toISOString().slice(0, 10)).toBe("2026-10-14");
    expect(header.deliverToName).toBe("ATLANTIC AUTO SPARES(LANGLAAG)");
    expect(header.billToName).toBe("CASH SALES JHB");
  });

  it("takes the date under Invoice date, not the order date beside it", async () => {
    const items = await extractFirstPageItems(
      await electroCityInvoice({ orderDate: "10/10/2026", invoiceDate: "14/10/2026" })
    );
    expect(readHeaderFromItems(items).invoiceDate?.toISOString().slice(0, 10)).toBe("2026-10-14");
  });

  it("reads a label: value layout too", () => {
    const header = readHeaderFromItems([
      { x: 40, y: 100, str: "Invoice Date:", width: 60, height: 9 },
      { x: 104, y: 100, str: "2026-10-14", width: 50, height: 9 },
    ]);
    expect(header.invoiceDate?.toISOString().slice(0, 10)).toBe("2026-10-14");
  });

  it("finds nothing on a page with no labels", () => {
    expect(
      readHeaderFromItems([{ x: 40, y: 100, str: "14/10/2026", width: 50, height: 9 }])
    ).toEqual({ invoiceDate: null, deliverToName: null, billToName: null });
  });
});

describe("parseInvoiceDate", () => {
  it.each([
    ["14/10/2026", "2026-10-14"],
    ["4/1/2026", "2026-01-04"], // day first
    ["14-10-2026", "2026-10-14"],
    ["14.10.2026", "2026-10-14"],
    ["2026-10-14", "2026-10-14"],
    ["Date: 14/10/2026 11:07", "2026-10-14"],
  ])("%s → %s", (raw, iso) => {
    expect(parseInvoiceDate(raw)?.toISOString().slice(0, 10)).toBe(iso);
  });

  it.each(["31/02/2026", "10/14/2026", "14/10/1899", "A136", ""])("rejects %j", (raw) => {
    expect(parseInvoiceDate(raw)).toBeNull();
  });
});
