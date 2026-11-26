/**
 * Reading an invoice's product lines off the PDF text layer.
 *
 * The client's invoices and credit notes come out of one accounting system,
 * with one table, so the fixture is the credit note's (positions copied from
 * the real CR-407712 / CR-407710) with "TAX INVOICE" in its title. It goes
 * through pdf.js exactly as a production PDF does.
 */

import { describe, it, expect } from "vitest";
import { extractPageItems, type TextItem } from "@/lib/invoice-header";
import { assessLines, readInvoiceFromPages, readPrintedInvoiceNo } from "@/lib/invoice-lines";
import { compileInvoiceNoPattern } from "@/lib/invoice-number";
import { CR_407710_LINES, CR_407712_LINES, creditNotePdf } from "./helpers/credit-note-fixture";

type FixtureOpts = Parameters<typeof creditNotePdf>[0];

async function invoicePages(opts: FixtureOpts = {}) {
  const pdf = await creditNotePdf({ documentTitle: "TAX INVOICE", creditNo: "634573", invoiceNo: null, ...opts });
  return extractPageItems(pdf);
}

describe("reading the client's invoice lines", () => {
  it("reads every line's code, description, quantity and unit", async () => {
    const invoice = readInvoiceFromPages(await invoicePages({ layout: "CR-407710" }));

    expect(invoice.invoiceNo).toBe("634573");
    expect(invoice.lines.map(({ lineNo, itemCode, shortName, description, qty, uom }) => ({ lineNo, itemCode, shortName, description, qty, uom }))).toEqual([
      { lineNo: 1, itemCode: "220740I", shortName: "CABLE 7COR 0.75 P30M", description: "0.75MM 7COR CABLE P/30MR", qty: 1, uom: "EACH" },
      { lineNo: 2, itemCode: "431456M", shortName: "REG", description: "12V HYBRID REG (MONARK)", qty: 1, uom: "EACH" },
      { lineNo: 3, itemCode: "0986AH0250", shortName: "RELAY", description: "12V 5PIN 30A BOSCH RELAY", qty: 2, uom: "EACH" },
    ]);
    expect(invoice.subtotal).toBe(775.5);
    expect(invoice.header.invoiceDate?.toISOString().slice(0, 10)).toBe("2025-11-25");
  });

  it("reads the earlier layout, with the product no and Qty a size larger", async () => {
    const invoice = readInvoiceFromPages(await invoicePages({ layout: "CR-407712" }));
    expect(invoice.invoiceNo).toBe("634573");
    expect(invoice.lines).toHaveLength(1);
    expect(invoice.lines[0]).toMatchObject({ itemCode: "618ABG", qty: 1, uom: "EACH", description: "BATT BM-618B41LB1 41AH 360CCA" });
  });

  it("numbers lines across pages, with the totals on the last", async () => {
    const pages = await invoicePages({ layout: "CR-407710", pages: [CR_407710_LINES.slice(0, 2), CR_407710_LINES.slice(2)] });
    const invoice = readInvoiceFromPages(pages);
    expect(invoice.lines.map((l) => [l.lineNo, l.itemCode])).toEqual([
      [1, "220740I"],
      [2, "431456M"],
      [3, "0986AH0250"],
    ]);
    expect(assessLines(invoice, "634573").status).toBe("OK");
  });

  it("keeps the prices it read in memory only — nothing priced is a stored field", async () => {
    const invoice = readInvoiceFromPages(await invoicePages({ layout: "CR-407710" }));
    for (const line of invoice.lines) {
      expect(Object.keys(line).sort()).toEqual(["description", "itemCode", "lineNo", "nett", "qty", "shortName", "uom"]);
    }
  });
});

describe("the invoice's own number", () => {
  const item = (str: string, x: number, y = 100): TextItem => ({ str, x, y, width: str.length * 6, height: 10 });

  it("takes the number beside the title, or inside it", () => {
    expect(readPrintedInvoiceNo([item("TAX INVOICE", 80), item("634573", 230)])).toBe("634573");
    expect(readPrintedInvoiceNo([item("Tax Invoice: IV-634573", 80)])).toBe("IV-634573");
    expect(readPrintedInvoiceNo([item("INVOICE No. 1047", 80)])).toBe("1047");
  });

  it("is not fooled by the Invoice date or Invoice to labels", () => {
    expect(readPrintedInvoiceNo([item("Invoice date", 80), item("14102026", 200)])).toBeNull();
    expect(readPrintedInvoiceNo([item("Invoice to:", 80), item("A136", 200)])).toBeNull();
  });
});

describe("checking a read before the office books against it", () => {
  const base = async () => readInvoiceFromPages(await invoicePages({ layout: "CR-407710" }));

  it("passes a full read of the right invoice", async () => {
    expect(assessLines(await base(), "634573")).toEqual({ status: "OK", issues: [] });
  });

  it("sends a PDF filed under another invoice's number to review", async () => {
    const { status, issues } = assessLines(await base(), "634574");
    expect(status).toBe("NEEDS_REVIEW");
    expect(issues.map((i) => i.code)).toContain("INVOICE_NO_MISMATCH");
  });

  it("compares the number as the registry does, prefixes and all", async () => {
    const invoice = { ...(await base()), invoiceNo: "IV-634573" };
    expect(assessLines(invoice, "634573").status).toBe("OK");
  });

  it("only warns when the printed number cannot be read", async () => {
    const { status, issues } = assessLines({ ...(await base()), invoiceNo: null }, "634573");
    expect(status).toBe("OK");
    expect(issues).toEqual([expect.objectContaining({ code: "INVOICE_NO_UNREAD", level: "warning" })]);
  });

  it("sends lines that do not add up to the sub total to review — a line was missed", async () => {
    const invoice = readInvoiceFromPages(await invoicePages({ layout: "CR-407710", subtotal: 900 }));
    const { status, issues } = assessLines(invoice, "634573");
    expect(status).toBe("NEEDS_REVIEW");
    expect(issues.find((i) => i.code === "LINES_TOTAL")?.message).toMatch(/775\.50.*900\.00/);
  });

  it("will not call a read complete when the sub total could not be read", async () => {
    const { status, issues } = assessLines({ ...(await base()), subtotal: null }, "634573");
    expect(status).toBe("NEEDS_REVIEW");
    expect(issues.map((i) => i.code)).toEqual(["TOTALS_UNCHECKED"]);
  });

  it("flags an invoice with no lines, and a line with no quantity", async () => {
    const invoice = await base();
    expect(assessLines({ ...invoice, lines: [] }, "634573").issues.map((i) => i.code)).toEqual(["NO_LINES"]);

    const zero = { ...invoice, lines: invoice.lines.map((l, i) => (i === 1 ? { ...l, qty: 0 } : l)) };
    const issue = assessLines(zero, "634573").issues.find((i) => i.code === "QTY_UNREAD");
    expect(issue).toMatchObject({ level: "review" });
    expect(issue?.message).toMatch(/line 2\b.*left out/);
  });

  it("uses the scope's own invoice-number pattern", async () => {
    const invoice = { ...(await base()), invoiceNo: "ZX-634573-B" };
    const compiled = compileInvoiceNoPattern("ZX-(?<num>\\d+)-B");
    expect(compiled.ok).toBe(true);
    expect(assessLines(invoice, "634573", compiled.ok ? compiled.pattern : null).status).toBe("OK");
  });
});

describe("the credit note reader still reads the shared table as before", () => {
  it("reads CR-407712's line", async () => {
    const { readCreditNoteFromPages } = await import("@/lib/credit-note");
    const note = readCreditNoteFromPages(await extractPageItems(await creditNotePdf()));
    expect(note.lines).toEqual([
      {
        lineNo: 1,
        productCode: CR_407712_LINES[0].productCode,
        shortName: "BATTERY",
        bin: "FLOOR",
        description: CR_407712_LINES[0].description,
        qty: 1,
        unitPrice: 720,
        discountPct: 0,
        nett: 720,
      },
    ]);
  });
});

describe("lines typed in by the office", () => {
  it("keeps quantities only, trims, and drops a row left blank", async () => {
    const { readManualLines } = await import("@/lib/invoice-lines-input");
    const out = readManualLines([
      { itemCode: " 220788 ", description: "30A  MINI FUSE", qty: "10", uom: "each", nett: 125, unitPrice: 12.5 },
      { itemCode: "", description: "", qty: "", uom: "" },
      { itemCode: "618ABG", description: "", qty: "2,5", uom: null },
    ]);
    expect(out).toEqual({
      ok: true,
      lines: [
        { itemCode: "220788", shortName: null, description: "30A MINI FUSE", qty: 10, uom: "each" },
        // No description: the code stands in for it, as a read does.
        { itemCode: "618ABG", shortName: null, description: "618ABG", qty: 2.5, uom: null },
      ],
    });
  });

  it("names the line that is wrong", async () => {
    const { readManualLines } = await import("@/lib/invoice-lines-input");
    expect(readManualLines([{ description: "A", qty: 1 }, { description: "B", qty: "0" }])).toMatchObject({ ok: false, line: 2 });
    expect(readManualLines([{ description: "A", qty: "two" }])).toMatchObject({ ok: false, line: 1 });
    expect(readManualLines([{ description: "A", qty: "1.2345" }])).toMatchObject({ ok: false, error: expect.stringMatching(/3 decimals/) });
    expect(readManualLines([{ qty: 3, uom: "EACH" }])).toMatchObject({ ok: false, error: expect.stringMatching(/description or a product code/) });
    expect(readManualLines([{ description: "A", qty: 1e10 }])).toMatchObject({ ok: false, error: expect.stringMatching(/too large/) });
  });

  it("refuses an empty list and a non-list", async () => {
    const { readManualLines, MAX_MANUAL_LINES } = await import("@/lib/invoice-lines-input");
    expect(readManualLines([])).toMatchObject({ ok: false, error: "Add at least one line" });
    expect(readManualLines([{}])).toMatchObject({ ok: false, error: "Add at least one line" });
    expect(readManualLines("lines")).toMatchObject({ ok: false });
    const many = Array.from({ length: MAX_MANUAL_LINES + 1 }, (_, i) => ({ description: `L${i}`, qty: 1 }));
    expect(readManualLines(many)).toMatchObject({ ok: false });
  });

  it("accepts three decimals without float noise", async () => {
    const { readManualLines } = await import("@/lib/invoice-lines-input");
    expect(readManualLines([{ description: "Cable", qty: "2.675", uom: "M" }])).toMatchObject({ ok: true, lines: [{ qty: 2.675 }] });
    expect(readManualLines([{ description: "Cable", qty: 0.1 + 0.2 }])).toMatchObject({ ok: true, lines: [{ qty: 0.3 }] });
  });
});
