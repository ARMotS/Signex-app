/**
 * Courier trip sheet rules (lib/courier-sheet.ts): reading a sheet out of the
 * client's export, the name its original is kept under, and what blocks the
 * courier signing for it. Storage and scoping are in isolation.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { BUILT_IN_COURIER_TRIP_SHEET, parseWithTemplate, readGrid, type Grid } from "@/lib/sheet-mapping";
import {
  assessCourierSheet,
  blocksHandover,
  companyKey,
  customerSlug,
  originalFileName,
  originalFolder,
  readCourierSheet,
  todayInJohannesburg,
  type LineFacts,
} from "@/lib/courier-sheet";

const TODAY = "2026-10-22";
const read = (grid: Grid, filename = "cts-200189-p5.xlsx", prompts: Record<string, string> = {}) =>
  readCourierSheet(parseWithTemplate(grid, BUILT_IN_COURIER_TRIP_SHEET, { filename, prompts }), {
    pattern: null,
    today: TODAY,
    typedSheetNo: prompts.courierSheetNo,
  });

const HEAD = ["Waybillno", "Customer", "INVOICENO", "Date", "NOP"];

describe("the client's export", () => {
  it("reads the anonymised sample end to end, sheet number from its name", () => {
    const file = path.join(__dirname, "fixtures", "sheets", "cts-200189-p5.xlsx");
    const grid = readGrid(fs.readFileSync(file), "cts-200189-p5.xlsx");
    if (!grid.ok) throw new Error(grid.error);
    const result = read(grid.grid, "cts-200189-p5.xlsx", { courierCompany: "MJV" });
    expect(result).toMatchObject({
      ok: true,
      sheet: {
        courierSheetNo: "200189",
        sheetDate: TODAY,
        courierCompany: "MJV",
        customerName: "Sample customer",
        waybills: ["700209"],
        parcels: 1,
        warnings: [],
      },
    });
    expect(result.ok && result.sheet.lines.map((l) => [l.invoiceNo, l.invoiceNoNormalized, l.invoiceDate, l.parcels])).toEqual([
      ["898714", "898714", "2026-10-14", 1],
      ["898715", "898715", "2026-10-14", null],
      ["898716", "898716", "2026-10-17", null],
    ]);
  });
});

describe("readCourierSheet", () => {
  it("asks for the sheet number when the file name has none, and takes a typed one", () => {
    const grid = [HEAD, ["700209", "Kilo", "1001", "", "1"]];
    expect(read(grid, "sample courier trip sheet.xlsx")).toMatchObject({ ok: false, code: "NEEDS_SHEET_NUMBER" });
    expect(read(grid, "sample courier trip sheet.xlsx", { courierSheetNo: "300001" })).toMatchObject({
      ok: true,
      sheet: { courierSheetNo: "300001" },
    });
  });

  it("refuses a sheet for two customers, naming them", () => {
    const result = read([HEAD, ["W1", "Kilo Kitchens", "1001", "", "1"], ["W2", "Lima Logistics", "1002", "", "1"]]);
    expect(result).toMatchObject({ ok: false, code: "MULTIPLE_CUSTOMERS", customers: ["Kilo Kitchens", "Lima Logistics"] });
  });

  it("treats spelling variants of one customer as one", () => {
    const result = read([HEAD, ["W1", "Kilo Hardware & Wholesaler", "1001", "", "1"], ["W1", "kilo hardware and wholesaler.", "1002", "", ""]]);
    expect(result).toMatchObject({ ok: true, sheet: { customerName: "Kilo Hardware & Wholesaler" } });
  });

  it("carries a merged waybill and customer down, and passes over the footer", () => {
    const result = read([
      HEAD,
      ["700209", "Kilo", "1001", "", "1"],
      ["", "", "1002", "", ""],
      ["700210", "", "1003", "", "2"],
      ["Received in good order and checked", "", "", "", ""],
    ]);
    expect(result.ok && result.sheet.lines.map((l) => [l.invoiceNo, l.waybillNo])).toEqual([
      ["1001", "700209"],
      ["1002", "700209"],
      ["1003", "700210"],
    ]);
  });

  it("adds up parcels per waybill — several waybills are allowed", () => {
    const result = read([
      HEAD,
      ["W1", "Kilo", "1001", "", "1"],
      ["W1", "Kilo", "1002", "", ""],
      ["W2", "Kilo", "1003", "", "3"],
    ]);
    expect(result).toMatchObject({ ok: true, sheet: { waybills: ["W1", "W2"], parcels: 4, warnings: [] } });
  });

  it("warns when one waybill gives two parcel counts", () => {
    const result = read([HEAD, ["W1", "Kilo", "1001", "", "1"], ["W1", "Kilo", "1002", "", "2"]]);
    expect(result.ok && result.sheet.parcels).toBe(1);
    expect(result.ok && result.sheet.warnings.map((w) => [w.code, w.level])).toEqual([["PARCELS_CONFLICT", "warning"]]);
  });

  it("lists an invoice once, however often the sheet repeats it", () => {
    const result = read([HEAD, ["W1", "Kilo", "IV-1001", "", "1"], ["W1", "Kilo", "1001", "", ""]]);
    expect(result.ok && result.sheet.lines.map((l) => l.invoiceNo)).toEqual(["IV-1001"]);
    expect(result.ok && result.sheet.warnings[0]).toMatchObject({ code: "DUPLICATE_INVOICE", level: "warning", invoiceNo: "1001" });
  });

  it("needs a template when the columns are not there", () => {
    expect(read([["Docket", "Account"], ["D1", "Kilo"]])).toMatchObject({ ok: false, code: "NEEDS_TEMPLATE" });
  });

  it("refuses a sheet with no invoices", () => {
    expect(read([HEAD, ["W1", "Kilo", "", "", ""]])).toMatchObject({ ok: false, code: "NO_INVOICES" });
  });
});

describe("the kept original", () => {
  it("is named for its sheet and customer", () => {
    expect(customerSlug("Kilo Hardware & Wholesaler (Pty) Ltd")).toBe("KILO-HARDWARE-WHOLESALER-PTY-LTD");
    expect(customerSlug("A".repeat(60))).toHaveLength(40);
    expect(customerSlug("&&&")).toBe("CUSTOMER");
    expect(originalFileName("200189", "Kilo Hardware", "cts-200189-p5.xlsx")).toBe("CTS200189_KILO-HARDWARE.xlsx");
    expect(originalFileName("200189", "Kilo Hardware", "cts-200189-p5.XLS", 2)).toBe("CTS200189_KILO-HARDWARE_2.xls");
    expect(originalFolder("2026-10-22")).toEqual(["Courier Trip Sheets", "2026", "10"]);
  });

  it("cannot be steered out of its folder by a sheet number", () => {
    expect(originalFileName("../../etc/200189", "Kilo", "x.xlsx")).toBe("CTSetc200189_KILO.xlsx");
  });
});

describe("assessCourierSheet", () => {
  const clean: LineFacts = {
    invoiceNo: "1001",
    invoiceFile: "IV-1001.pdf",
    signedInHouse: false,
    liveRun: null,
    otherCourierSheet: null,
  };
  const withEmail = { found: true, email: "orders@kilo.test" };

  it("has nothing to say about a clean sheet", () => {
    expect(assessCourierSheet({ lines: [clean], contact: withEmail })).toEqual([]);
  });

  it("blocks the handover over the goods and the paperwork", () => {
    const issues = assessCourierSheet({
      lines: [
        { ...clean, invoiceNo: "1", invoiceFile: null },
        { ...clean, invoiceNo: "2", signedInHouse: true },
        { ...clean, invoiceNo: "3", liveRun: { driverName: "Jane Delivery" } },
        { ...clean, invoiceNo: "4", otherCourierSheet: { courierSheetNo: "200100" } },
      ],
      contact: withEmail,
    });
    expect(issues.map((i) => [i.code, i.level, i.invoiceNo])).toEqual([
      ["INVOICE_NOT_FOUND", "block", "1"],
      ["ALREADY_SIGNED", "block", "2"],
      ["ON_LIVE_RUN", "block", "3"],
      ["ON_OTHER_COURIER_SHEET", "block", "4"],
    ]);
    expect(issues[2].message).toContain("Jane Delivery");
    expect(blocksHandover(issues)).toBe(true);
  });

  it("only warns about the contact — the courier can still sign (client decision)", () => {
    const none = assessCourierSheet({ lines: [clean], contact: { found: false, email: null } });
    const noEmail = assessCourierSheet({ lines: [clean], contact: { found: true, email: null } });
    expect(none.map((i) => [i.code, i.level])).toEqual([["NO_CONTACT", "warning"]]);
    expect(noEmail.map((i) => [i.code, i.level])).toEqual([["NO_EMAIL", "warning"]]);
    expect(blocksHandover([...none, ...noEmail])).toBe(false);
    expect(none[0].message).toMatch(/confirmation email/);
  });

  it("keeps what the import found", () => {
    const issues = assessCourierSheet({
      lines: [clean],
      contact: withEmail,
      readWarnings: [{ code: "PARCELS_CONFLICT", level: "warning", message: "x" }],
    });
    expect(issues.map((i) => i.code)).toEqual(["PARCELS_CONFLICT"]);
  });
});

describe("companyKey", () => {
  it("ignores case, punctuation and & versus and", () => {
    expect(companyKey(" Kilo  Hardware & Wholesaler. ")).toBe("kilo hardware and wholesaler");
    expect(companyKey("Mike's Motors")).toBe(companyKey("mikes motors").replace("mikes", "mike s"));
  });
});

describe("todayInJohannesburg", () => {
  it("is South African time, not UTC", () => {
    // 23:30 UTC is already the next day in Johannesburg (UTC+2).
    expect(todayInJohannesburg(new Date("2026-10-21T23:30:00Z"))).toBe("2026-10-22");
    expect(todayInJohannesburg(new Date("2026-10-21T21:30:00Z"))).toBe("2026-10-21");
  });
});
