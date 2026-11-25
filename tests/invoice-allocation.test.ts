import { describe, it, expect, vi, beforeEach } from "vitest";

// The scoped client, as the two readers use it. Each test sets the rows.
let stopRows: unknown[] = [];
let courierRows: unknown[] = [];
const calls: { model: string; where: unknown }[] = [];
vi.mock("@/lib/db-scoped", () => ({
  scopedPrisma: () => ({
    stop: { findMany: async (args: { where: unknown }) => (calls.push({ model: "stop", where: args.where }), stopRows) },
    courierTripSheetInvoice: {
      findMany: async (args: { where: unknown }) => (calls.push({ model: "courier", where: args.where }), courierRows),
    },
  }),
}));

import {
  allocationOf,
  findOnCourierSheet,
  readInvoiceAllocations,
  type AllocationFacts,
} from "@/lib/invoice-allocation";

const none: AllocationFacts = { stops: [], courier: [], signedCopy: false };
const stop = (status: string, tripName = "ts-103573-j6") => ({
  status,
  tripSheetId: `trip-${tripName}`,
  tripName,
  driverName: "SAMANTHA",
});
const sheet = (status: string, courierSheetNo = "200189") => ({ courierSheetId: `cts-${courierSheetNo}`, courierSheetNo, status });

describe("allocationOf", () => {
  it("is available when nothing holds it — the only selectable state", () => {
    expect(allocationOf(none)).toEqual({ state: "AVAILABLE", selectable: true, run: null, courierSheet: null, signed: false });
  });

  it("a PENDING or IN_PROGRESS stop puts it on a run, named by trip and driver", () => {
    for (const status of ["PENDING", "IN_PROGRESS"]) {
      const a = allocationOf({ ...none, stops: [stop(status)] });
      expect(a.state).toBe("ON_RUN");
      expect(a.selectable).toBe(false);
      expect(a.run).toEqual({ tripSheetId: "trip-ts-103573-j6", tripName: "ts-103573-j6", driverName: "SAMANTHA", stopStatus: status });
    }
  });

  it("a signed stop or a filed signed copy reads signed", () => {
    expect(allocationOf({ ...none, stops: [stop("SIGNED")] })).toMatchObject({ state: "SIGNED", selectable: false, run: null, signed: true });
    expect(allocationOf({ ...none, signedCopy: true })).toMatchObject({ state: "SIGNED", signed: true });
  });

  it("an open courier sheet holds it; a completed one has sent it", () => {
    for (const status of ["NEEDS_ATTENTION", "AWAITING_COLLECTION"]) {
      expect(allocationOf({ ...none, courier: [sheet(status)] })).toMatchObject({
        state: "ON_COURIER_SHEET",
        courierSheet: { id: "cts-200189", courierSheetNo: "200189", completed: false },
      });
    }
    for (const status of ["COLLECTED", "DELIVERED"]) {
      expect(allocationOf({ ...none, courier: [sheet(status)] })).toMatchObject({
        state: "WITH_COURIER",
        courierSheet: { completed: true },
      });
    }
  });

  it("names what the office can still act on first: run, open sheet, completed sheet, signature", () => {
    // A double deploy from before ALREADY_ON_RUN: one copy signed, one still out.
    expect(allocationOf({ ...none, stops: [stop("SIGNED", "a"), stop("PENDING", "b")] })).toMatchObject({
      state: "ON_RUN",
      run: { tripName: "b" },
      signed: true,
    });
    expect(allocationOf({ ...none, stops: [stop("PENDING")], courier: [sheet("AWAITING_COLLECTION")] }).state).toBe("ON_RUN");
    const both = allocationOf({ ...none, courier: [sheet("COLLECTED", "1"), sheet("AWAITING_COLLECTION", "2")], signedCopy: true });
    expect(both).toMatchObject({ state: "ON_COURIER_SHEET", courierSheet: { courierSheetNo: "2" }, signed: true });
    expect(allocationOf({ ...none, courier: [sheet("COLLECTED")], signedCopy: true }).state).toBe("WITH_COURIER");
  });
});

describe("readInvoiceAllocations", () => {
  beforeEach(() => {
    calls.length = 0;
    stopRows = [];
    courierRows = [];
  });

  it("answers every key asked for, and asks nothing for none", async () => {
    expect((await readInvoiceAllocations("t", [])).size).toBe(0);
    expect(calls).toEqual([]);

    stopRows = [
      { invoiceNoNormalized: "1001", status: "PENDING", tripSheet: { id: "trip-1", sourceFilename: "ts-1", driver: { name: "Jane" } } },
    ];
    courierRows = [
      { invoiceNoNormalized: "1002", courierSheet: { id: "cts-9", courierSheetNo: "200189", status: "AWAITING_COLLECTION" } },
    ];
    const map = await readInvoiceAllocations("t", ["1001", "1002", "1003", "1004", "1001", ""], {
      signedKeys: new Set(["1004"]),
    });
    expect([...map.keys()]).toEqual(["1001", "1002", "1003", "1004"]);
    expect(map.get("1001")).toMatchObject({ state: "ON_RUN", run: { tripName: "ts-1", driverName: "Jane" } });
    expect(map.get("1002")).toMatchObject({ state: "ON_COURIER_SHEET", courierSheet: { courierSheetNo: "200189" } });
    expect(map.get("1003")?.state).toBe("AVAILABLE");
    expect(map.get("1004")?.state).toBe("SIGNED");
    expect(calls.map((c) => c.where)).toEqual([
      { invoiceNoNormalized: { in: ["1001", "1002", "1003", "1004"] } },
      { invoiceNoNormalized: { in: ["1001", "1002", "1003", "1004"] } },
    ]);
  });

  it("reads the scope's rows instead of an IN list for a whole folder, keeping only those asked for", async () => {
    const keys = Array.from({ length: 501 }, (_, i) => String(i + 1));
    stopRows = [
      { invoiceNoNormalized: "99999", status: "PENDING", tripSheet: { id: "x", sourceFilename: "x", driver: null } },
    ];
    const map = await readInvoiceAllocations("t", keys);
    expect(calls[0].where).toEqual({ invoiceNoNormalized: { not: null } });
    expect(map.size).toBe(501);
    expect(map.has("99999")).toBe(false);
  });
});

describe("findOnCourierSheet", () => {
  beforeEach(() => {
    calls.length = 0;
    courierRows = [];
  });

  it("names each sheet invoice a courier sheet holds, as the sheet wrote it, preferring an open sheet", async () => {
    courierRows = [
      { invoiceNoNormalized: "643008", courierSheet: { id: "a", courierSheetNo: "200100", status: "COLLECTED" } },
      { invoiceNoNormalized: "643008", courierSheet: { id: "b", courierSheetNo: "200189", status: "AWAITING_COLLECTION" } },
      { invoiceNoNormalized: "643010", courierSheet: { id: "c", courierSheetNo: "200150", status: "DELIVERED" } },
    ];
    const found = await findOnCourierSheet("t", ["IV-643008", "643008", "643009", "INV-643010"], null);
    expect(found).toEqual([
      { invoiceNumber: "IV-643008", courierSheetNo: "200189", completed: false },
      { invoiceNumber: "INV-643010", courierSheetNo: "200150", completed: true },
    ]);
    expect(calls).toEqual([{ model: "courier", where: { invoiceNoNormalized: { in: ["643008", "643009", "643010"] } } }]);
  });

  it("asks nothing when the sheet has no delivery invoices", async () => {
    expect(await findOnCourierSheet("t", ["", "-"], null)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
