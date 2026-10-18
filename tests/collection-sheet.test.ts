/**
 * Reading the office's collection sheet, and checking it against the trip
 * sheet row.
 *
 * The fixture is drawn to the client's real sheet (CRCOL-1797) and goes
 * through pdf.js exactly as a production PDF does. The real file read the same
 * way during development; it is client paperwork, so it is not committed.
 */

import { describe, it, expect } from "vitest";
import { extractPageItems } from "@/lib/invoice-header";
import { assessSheet, readSheetFromPages, type ParsedSheet } from "@/lib/collection-sheet";
import { collectionMatchKeys, sameCollectionNumber } from "@/lib/collections";
import { collectionSheetPdf, CRCOL_1797_LINES } from "./helpers/collection-sheet-fixture";

const read = async (pdf: Buffer) => readSheetFromPages(await extractPageItems(pdf));

describe("reading the client's credit collection sheet", () => {
  it("reads the header", async () => {
    const sheet = await read(await collectionSheetPdf());
    expect(sheet).toMatchObject({
      collectionNo: "001797",
      invoiceNo: "130522",
      customerName: "VISA AUTO ELECTRICAL",
      accountNo: "V002",
      collectionDate: "2025-11-25",
    });
  });

  it("reads each line across its two baselines: Qty expected, Returned as printed, the Reason code", async () => {
    const sheet = await read(await collectionSheetPdf());
    expect(sheet.lines).toEqual([
      { lineNo: 1, itemCode: "CABLE 7COR", shortName: "CABLE 7COR 0.75", description: "0.75MM 7COR CABLE P/30MR", qtyListed: 1, qtyReturnedPrinted: 0, reasonCode: "1" },
      { lineNo: 2, itemCode: "REG", shortName: "REG", description: "12V HYBRID REG (MONARK)", qtyListed: 1, qtyReturnedPrinted: 0, reasonCode: "2" },
      { lineNo: 3, itemCode: "RELAY", shortName: "RELAY", description: "12V 5PIN 30A BOSCH RELAY", qtyListed: 2, qtyReturnedPrinted: 0, reasonCode: "3" },
    ]);
  });

  it("stops at the end of the table — the terms below are not lines", async () => {
    const sheet = await read(await collectionSheetPdf());
    expect(sheet.lines).toHaveLength(3);
    expect(sheet.lines.some((l) => /goods remain/i.test(l.description))).toBe(false);
  });

  it("numbers lines on across pages", async () => {
    const sheet = await read(
      await collectionSheetPdf({ pages: [CRCOL_1797_LINES, [CRCOL_1797_LINES[0]]] })
    );
    expect(sheet.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4]);
    expect(sheet.lines[3].description).toBe("0.75MM 7COR CABLE P/30MR");
  });

  it("reads a sheet with no invoice number as one with none", async () => {
    const sheet = await read(await collectionSheetPdf({ invoiceNo: null }));
    expect(sheet.invoiceNo).toBeNull();
    expect(sheet.lines).toHaveLength(3);
  });
});

describe("matching a collection number however it is written", () => {
  it.each(["1797", "001797", "CRCOL-1797", "CRCOL1797", "CR COL 1797", "Credit Collection Sheet No. 1797", "COL-1797.pdf"])(
    "%s is collection 1797",
    (written) => {
      expect(sameCollectionNumber(written, "1797")).toBe(true);
      expect(sameCollectionNumber(written, "CRCOL-1797")).toBe(true);
    }
  );

  it("keeps letters after the number: C001A is not C001", () => {
    expect(sameCollectionNumber("C001A", "C001")).toBe(false);
    expect(sameCollectionNumber("C001A", "1")).toBe(false);
    // Letters after the number survive prefix stripping in the match keys too.
    expect(collectionMatchKeys("C001A")[0]).toBe("001A");
  });

  it("keeps different numbers apart", () => {
    expect(sameCollectionNumber("CRCOL-1797", "1798")).toBe(false);
  });
});

describe("checking the sheet against the trip sheet row", () => {
  const sheet = (over: Partial<ParsedSheet> = {}): ParsedSheet => ({
    collectionNo: "001797",
    invoiceNo: "130522",
    customerName: "VISA AUTO ELECTRICAL",
    accountNo: "V002",
    collectionDate: "2025-11-25",
    lines: [
      { lineNo: 1, itemCode: "REG", shortName: null, description: "12V REG", qtyListed: 4, qtyReturnedPrinted: 0, reasonCode: "1" },
    ],
    ...over,
  });
  const row = {
    collectionNo: "1797",
    invoiceNoNormalized: "130522",
    customerName: "Visa Auto Electrical",
    isUplift: false,
  };

  it("is READY when it agrees — and a line total is never compared with the box count", () => {
    expect(assessSheet(sheet(), row, "TEXT")).toEqual({ status: "READY", issues: [], lineType: "CREDIT_RETURN" });
  });

  it("needs review for another collection's sheet", () => {
    const a = assessSheet(sheet({ collectionNo: "001798" }), row, "TEXT");
    expect(a.status).toBe("NEEDS_REVIEW");
    expect(a.issues.map((i) => i.code)).toEqual(["COLLECTION_NO_MISMATCH"]);
  });

  it("needs review when the sheet is against a different invoice", () => {
    const a = assessSheet(sheet({ invoiceNo: "IV-130999" }), row, "TEXT");
    expect(a.status).toBe("NEEDS_REVIEW");
    expect(a.issues.map((i) => i.code)).toContain("INVOICE_MISMATCH");
  });

  it("matches the invoice however it is printed", () => {
    expect(assessSheet(sheet({ invoiceNo: "IV-130522" }), row, "TEXT").status).toBe("READY");
  });

  it("needs review when nothing could be read", () => {
    expect(assessSheet(sheet({ lines: [] }), row, "TEXT").issues.map((i) => i.code)).toContain("NO_LINES");
  });

  it("reads a sheet with no invoice behind it as non-credit uplifts, not as a mismatch", () => {
    const a = assessSheet(sheet({ invoiceNo: null }), { ...row, invoiceNoNormalized: null }, "TEXT");
    expect(a).toEqual({ status: "READY", issues: [], lineType: "NON_CREDIT_UPLIFT" });
  });

  it("follows the trip sheet when it marks the row an uplift", () => {
    expect(assessSheet(sheet(), { ...row, isUplift: true }, "TEXT").lineType).toBe("NON_CREDIT_UPLIFT");
  });

  it("warns, but does not hold up, a different customer or a scan", () => {
    const a = assessSheet(sheet({ customerName: "SOMEONE ELSE MOTORS" }), row, "AI");
    expect(a.status).toBe("READY");
    expect(a.issues.map((i) => [i.code, i.level])).toEqual([
      ["CUSTOMER_MISMATCH", "warning"],
      ["READ_FROM_SCAN", "warning"],
    ]);
  });
});
