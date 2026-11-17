import { describe, it, expect } from "vitest";
import { collectAlreadyOnRun, alreadyOnRunRefusal, type AlreadyOnRunInvoice } from "@/lib/trip-parser";

// The deploy-time half of the double-deploy guard: of the invoices the preview
// found on a live run, which would this deploy actually write?

const onRun = (invoiceNumber: string): AlreadyOnRunInvoice => ({
  invoiceNumber,
  driverName: "SAMANTHA",
  sourceFilename: "ts-103573-j6.xls",
  status: "PENDING",
});

const stop = (invoiceNumber: string) => ({ invoiceNumber }) as never;

const result = (driverId: string, invoices: string[]) =>
  ({ driverId, driverName: driverId, regNo: "", stops: invoices.map(stop) }) as never;

describe("collectAlreadyOnRun", () => {
  it("refuses an invoice the deploy would write", () => {
    const found = collectAlreadyOnRun(
      { alreadyOnRun: [onRun("643008")], driverResults: [result("d1", ["643008", "643009"])] },
      new Set()
    );
    expect(found.map((i) => i.invoiceNumber)).toEqual(["643008"]);
  });

  it("lets a skipped invoice through, ignoring case", () => {
    const found = collectAlreadyOnRun(
      { alreadyOnRun: [onRun("iv-643008")], driverResults: [result("d1", ["iv-643008"])] },
      new Set(["IV-643008"])
    );
    expect(found).toEqual([]);
  });

  it("ignores unassigned rows until a driver is chosen for them", () => {
    const input = {
      alreadyOnRun: [onRun("643010")],
      driverResults: [result("__unassigned__", ["643010"])],
    };
    expect(collectAlreadyOnRun(input, new Set())).toEqual([]);
    expect(collectAlreadyOnRun(input, new Set(), { includeUnassigned: true })).toHaveLength(1);
  });

  it("never counts a collection-only stop (no invoice number)", () => {
    const found = collectAlreadyOnRun(
      { alreadyOnRun: [onRun("")], driverResults: [result("d1", [""])] },
      new Set()
    );
    expect(found).toEqual([]);
  });
});

describe("alreadyOnRunRefusal", () => {
  it("names the invoice and the driver whose run holds it", () => {
    const body = alreadyOnRunRefusal([onRun("643008")]);
    expect(body.code).toBe("ALREADY_ON_RUN");
    expect(body.error).toContain("643008");
    expect(body.error).toContain("SAMANTHA");
  });

  it("summarises several", () => {
    const body = alreadyOnRunRefusal([onRun("1"), onRun("2"), onRun("3")]);
    expect(body.error).toMatch(/^3 invoices/);
    expect(body.alreadyOnRun).toHaveLength(3);
  });
});
