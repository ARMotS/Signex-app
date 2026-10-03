/**
 * COLLECTNO on the trip sheet.
 *
 * The four shapes a sheet can take are the four fixtures below: a delivery on
 * its own, a collection on its own, both on one row, and a legacy sheet written
 * before the column existed. The last one is the one that matters most — every
 * depot has sheets in that format, and a parser that needed the new column
 * would reject a day's work on the morning it shipped.
 *
 * Everything the parser reaches out to is stubbed, so this runs with no
 * database, no invoice folder and no OneDrive connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

// ─── Stubbed candidate pools ──────────────────────────────────────────────

let invoiceFiles: { filename: string; invoiceNumber: string; isSigned: boolean }[] = [];
let collectionDocs: { filename: string; name: string; collectionNo: string; sizeBytes: number; lastModified: string; itemId?: string }[] = [];
let drivers: { id: string; name: string }[] = [];
let collectionFolderError: string | undefined;

vi.mock("@/lib/invoices", () => ({
  listInvoiceFiles: vi.fn(async () => invoiceFiles),
}));

vi.mock("@/lib/accounts", () => ({
  listDrivers: vi.fn(async () => drivers),
}));

// Only the folder listing is stubbed. The matching helpers are the real ones —
// a test that mocked those would prove nothing about how a COLLECTNO on a sheet
// finds its document.
vi.mock("@/lib/collections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/collections")>();
  return {
    ...actual,
    listCollectionFolder: vi.fn(async () => ({
      source: "onedrive" as const,
      folderPath: "/Signex/Collections",
      documents: collectionDocs,
      ...(collectionFolderError ? { error: collectionFolderError } : {}),
    })),
  };
});

// The already-signed check is the only database read on this path.
vi.mock("@/lib/db-scoped", () => ({
  scopedPrisma: () => ({ stop: { findMany: async () => [] } }),
}));

import { parseTripSheet, parseCollectionTyping, collectMissingInvoices } from "@/lib/trip-parser";

const TENANT = "tenant-1";

function doc(collectionNo: string) {
  return {
    filename: `${collectionNo}.pdf`,
    name: collectionNo,
    collectionNo: collectionNo.toUpperCase(),
    sizeBytes: 1024,
    lastModified: new Date().toISOString(),
    itemId: `item-${collectionNo}`,
  };
}

function invoice(invoiceNumber: string) {
  return { filename: `${invoiceNumber}.pdf`, invoiceNumber, isSigned: false };
}

const csv = (rows: string[][]) => Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf-8");

const parse = (rows: string[][]) => parseTripSheet(TENANT, csv(rows), "trip.csv");

/** The current header layout: COLLECTNO between INVOICENO and NOP. */
const HEADERS = ["Date", "Driver", "REGNO", "Customer", "INVOICENO", "COLLECTNO", "COLLECTTYPE", "NOP"];
/** A sheet produced before collections existed. */
const LEGACY_HEADERS = ["Date", "Driver", "REGNO", "Customer", "INVOICENO", "NOP"];

beforeEach(() => {
  invoiceFiles = [invoice("INV-2041"), invoice("INV-2042")];
  collectionDocs = [doc("COL-118"), doc("COL-119")];
  drivers = [{ id: "driver-1", name: "John Smith" }];
  collectionFolderError = undefined;
});

// ─── The four sheet shapes ────────────────────────────────────────────────

describe("fixture: a legacy sheet with no COLLECTNO column", () => {
  it("parses exactly as it always did", async () => {
    const result = await parse([
      LEGACY_HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "3"],
      ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-2042", "1"],
    ]);

    expect(result.success).toBe(true);
    expect(result.totalRows).toBe(2);
    expect(result.matchedInvoices).toBe(2);
    expect(result.totalCollections).toBe(0);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.invoiceNumber)).toEqual(["INV-2041", "INV-2042"]);
    expect(stops.every((s) => (s.collections ?? []).length === 0)).toBe(true);
  });

  it("still rejects a sheet with neither column", async () => {
    const result = await parse([
      ["Date", "Driver", "Customer"],
      ["2026-08-24", "John Smith", "Acme Hardware"],
    ]);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invoice number or collection number column/i);
  });
});

describe("fixture: an invoice-only row", () => {
  it("becomes a stop with no collections", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "", "", "3"],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({
      invoiceNumber: "INV-2041",
      customerName: "Acme Hardware",
      invoiceFile: "INV-2041.pdf",
      nop: 3,
    });
    expect(stops[0].collections).toEqual([]);
    expect(result.totalCollections).toBe(0);
  });
});

describe("fixture: a collection-only row", () => {
  it("becomes a stop with a blank invoice number and one collection", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Delta Trading", "", "COL-119", "Crates", ""],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0].invoiceNumber).toBe("");
    expect(stops[0].customerName).toBe("Delta Trading");
    expect(stops[0].invoiceFile).toBeUndefined();

    expect(stops[0].collections).toHaveLength(1);
    expect(stops[0].collections![0]).toMatchObject({
      collectionNo: "COL-119",
      type: "NON_CREDIT_UPLIFT",
      upliftSubtype: "EQUIPMENT_OR_CRATES",
      sourceFilePath: "COL-119.pdf",
      sourceFileId: "item-COL-119",
      status: "PENDING",
    });
  });

  it("is exempt from the missing-invoice gate — there is no invoice to be missing", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Delta Trading", "", "COL-119", "", ""],
    ]);

    expect(result.missingInvoices).toEqual([]);
    expect(collectMissingInvoices(result.driverResults, new Set())).toEqual([]);
  });

  it("does not let a blank invoice cell alone create a stop", async () => {
    // The exemption keys on the stop having no invoice number, so it must be
    // impossible to reach it with a row that is simply missing its invoice.
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Ghost Supplies", "", "", "", "2"],
    ]);

    expect(result.totalRows).toBe(0);
    expect(result.driverResults).toEqual([]);
  });
});

describe("fixture: a row carrying both an invoice and a collection", () => {
  it("produces one stop with the collection attached", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-2042", "COL-118", "", "1"],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0].invoiceNumber).toBe("INV-2042");
    expect(stops[0].invoiceFile).toBe("INV-2042.pdf");
    expect(stops[0].collections).toHaveLength(1);
  });

  it("credits the collection against that row's own invoice by default", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-2042", "COL-118", "", "1"],
    ]);

    const collection = result.driverResults[0].stops[0].collections![0];
    expect(collection.type).toBe("CREDIT_RETURN");
    expect(collection.originalInvoiceNo).toBe("INV-2042");
  });

  it("lets an explicit column override which invoice is credited", async () => {
    const result = await parseTripSheet(
      TENANT,
      csv([
        [...HEADERS, "ORIGINALINVOICENO"],
        ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-2042", "COL-118", "", "1", "INV-1990"],
      ]),
      "trip.csv"
    );

    expect(result.driverResults[0].stops[0].collections![0].originalInvoiceNo).toBe("INV-1990");
  });
});

// ─── Grouping ─────────────────────────────────────────────────────────────

describe("grouping collections onto a customer's stop", () => {
  it("attaches a collection-only row to that customer's existing stop", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "", "", "3"],
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "", "COL-118", "", ""],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0].invoiceNumber).toBe("INV-2041");
    expect(stops[0].collections).toHaveLength(1);
    expect(stops[0].collections![0].collectionNo).toBe("COL-118");
  });

  it("attaches it even when the invoice row comes later on the sheet", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "", "COL-118", "", ""],
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "", "", "3"],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0].collections).toHaveLength(1);
    expect(stops[0].stopNumber).toBe(1);
  });

  it("matches the customer case-insensitively", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "", "", "3"],
      ["2026-08-24", "John Smith", "CA 123-456", "ACME HARDWARE", "", "COL-118", "", ""],
    ]);

    expect(result.driverResults[0].stops).toHaveLength(1);
  });

  it("does NOT merge two invoice rows for the same customer", async () => {
    // Invoice behaviour is untouched: two invoices are still two stops, each
    // with its own PDF and its own signature.
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "", "", "3"],
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2042", "", "", "1"],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(2);
    expect(stops.map((s) => s.stopNumber)).toEqual([1, 2]);
  });

  it("never groups unnamed customers together", async () => {
    // Two blank customers are two different places, not one stop called Unknown.
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "", "", "COL-118", "", ""],
      ["2026-08-24", "John Smith", "CA 123-456", "", "", "COL-119", "", ""],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(2);
    expect(stops.every((s) => s.customerName === "Unknown")).toBe(true);
  });

  it("keeps a collection with the driver whose rows it arrived on", async () => {
    drivers = [
      { id: "driver-1", name: "John Smith" },
      { id: "driver-2", name: "Thandi Nkosi" },
    ];

    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "", "", "3"],
      ["2026-08-24", "Thandi Nkosi", "CJ 998-221", "Acme Hardware", "", "COL-118", "", ""],
    ]);

    const byDriver = Object.fromEntries(
      result.driverResults.map((r) => [r.driverName, r])
    );

    // Same customer, two drivers: the collection belongs to the driver who was
    // sent to fetch it, not to whoever happens to be delivering there.
    expect(byDriver["John Smith"].stops[0].collections).toHaveLength(0);
    expect(byDriver["Thandi Nkosi"].stops[0].collections).toHaveLength(1);
  });

  it("renumbers stops contiguously when a collection row merges away", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "", "", "3"],
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "", "COL-118", "", ""],
      ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-2042", "", "", "1"],
    ]);

    expect(result.driverResults[0].stops.map((s) => s.stopNumber)).toEqual([1, 2]);
  });
});

// ─── Document matching ────────────────────────────────────────────────────

describe("matching a COLLECTNO to a document", () => {
  it("counts a collection with no document as unmatched, without blocking it", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "COL-404", "", "3"],
    ]);

    expect(result.totalCollections).toBe(1);
    expect(result.matchedCollections).toBe(0);
    expect(result.unmatchedCollections).toBe(1);
    expect(result.driverResults[0].unmatchedCollections).toEqual(["COL-404"]);

    // Unmatched, but still deployable — the receipt is generated at signing.
    expect(result.missingInvoices).toEqual([]);
    const collection = result.driverResults[0].stops[0].collections![0];
    expect(collection.sourceFilePath).toBeNull();
  });

  it("matches loosely, the way invoice numbers do", async () => {
    collectionDocs = [doc("118")];

    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "COL-118", "", "3"],
    ]);

    expect(result.matchedCollections).toBe(1);
    expect(result.driverResults[0].stops[0].collections![0].sourceFilePath).toBe("118.pdf");
  });
});

describe("an unreadable collections folder", () => {
  it("says so, instead of reporting every collection as merely unpapered", async () => {
    collectionDocs = [];
    collectionFolderError = "Could not read the OneDrive collections folder: 401";

    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "COL-118", "", "3"],
    ]);

    expect(result.success).toBe(true);
    expect(result.unmatchedCollections).toBe(1);
    expect(result.collectionsFolderError).toBe(collectionFolderError);
  });

  it("stays quiet on a sheet with no collections", async () => {
    collectionFolderError = "Could not read the OneDrive collections folder: 401";

    const result = await parse([
      LEGACY_HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "3"],
    ]);

    expect(result.collectionsFolderError).toBeUndefined();
  });
});

// ─── Header tolerance ─────────────────────────────────────────────────────

describe("header tolerance", () => {
  it.each([
    "COLLECTNO",
    "Collection No",
    "COLLECTION NO.",
    "Coll No",
    "Collect #",
    "Collection Number",
  ])("recognises %s", async (header) => {
    const result = await parse([
      ["Driver", "Customer", "INVOICENO", header, "NOP"],
      ["John Smith", "Acme Hardware", "INV-2041", "COL-118", "3"],
    ]);

    expect(result.totalCollections).toBe(1);
  });
});

// ─── Type interpretation ──────────────────────────────────────────────────

describe("parseCollectionTyping", () => {
  it("defaults to a credit return", () => {
    expect(parseCollectionTyping("")).toEqual({
      type: "CREDIT_RETURN",
      upliftSubtype: null,
    });
  });

  it.each([
    ["Crates", "EQUIPMENT_OR_CRATES"],
    ["equipment", "EQUIPMENT_OR_CRATES"],
    ["Company Parcel", "COMPANY_PARCEL"],
    ["Documents", "DOCUMENTS"],
    ["Special Request", "SPECIAL_REQUEST"],
  ])("reads %s as an uplift", (raw, subtype) => {
    expect(parseCollectionTyping(raw)).toEqual({
      type: "NON_CREDIT_UPLIFT",
      upliftSubtype: subtype,
    });
  });

  it("gives a bare uplift a subtype rather than an invalid one", () => {
    // NON_CREDIT_UPLIFT with no subtype fails validateCollectionType, which
    // would reject the whole sheet over one vague cell.
    const typing = parseCollectionTyping("uplift");
    expect(typing.type).toBe("NON_CREDIT_UPLIFT");
    expect(typing.upliftSubtype).toBeTruthy();
  });

  it("treats an unrecognised word as a credit return", () => {
    expect(parseCollectionTyping("misc").type).toBe("CREDIT_RETURN");
  });
});

// ─── Excel ────────────────────────────────────────────────────────────────

describe("the Excel path reads COLLECTNO too", () => {
  it("parses an .xlsx sheet identically to the CSV", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        HEADERS,
        ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "COL-118", "Credit Return", 3],
        ["2026-08-24", "John Smith", "CA 123-456", "Delta Trading", "", "COL-119", "Documents", 0],
      ]),
      "Trip Sheet"
    );
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const result = await parseTripSheet(TENANT, buffer, "trip.xlsx");

    expect(result.success).toBe(true);
    expect(result.totalCollections).toBe(2);
    expect(result.matchedCollections).toBe(2);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(2);
    expect(stops[0].collections![0].type).toBe("CREDIT_RETURN");
    expect(stops[1].collections![0]).toMatchObject({
      type: "NON_CREDIT_UPLIFT",
      upliftSubtype: "DOCUMENTS",
    });
  });
});
