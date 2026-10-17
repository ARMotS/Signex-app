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

// The already-signed check and the tenant's invoice-number pattern are the
// only database reads on this path. No stored pattern: the built-in rule.
vi.mock("@/lib/db-scoped", () => ({
  scopedPrisma: () => ({
    stop: { findMany: async () => [] },
    appConfig: { findUnique: async () => null },
  }),
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
  it("credits the collection against the row's invoice", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-2042", "COL-118", "", "1"],
    ]);

    const collection = result.driverResults[0].stops[0].collections![0];
    expect(collection.type).toBe("CREDIT_RETURN");
    expect(collection.originalInvoiceNo).toBe("INV-2042");
  });

  it("does not deliver the credited invoice", async () => {
    // The row's invoice is the one goods go back against, not one being
    // dropped off — so no delivery stop, and no PDF needed to deploy.
    invoiceFiles = [];
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-1990", "COL-118", "", "1"],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0].invoiceNumber).toBe("");
    expect(stops[0].invoiceFile).toBeUndefined();
    expect(stops[0].collections).toHaveLength(1);
    expect(result.missingInvoices).toEqual([]);
    expect(result.matchedInvoices).toBe(0);
    expect(result.unmatchedInvoices).toBe(0);
    expect(collectMissingInvoices(result.driverResults, new Set())).toEqual([]);
  });

  it("joins the customer's delivery when that is on a separate row", async () => {
    // A delivery to the same customer comes on its own row; the driver sees
    // one visit carrying the delivery and the collection.
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-1990", "COL-118", "", ""],
      ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-2042", "", "", "1"],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0].invoiceNumber).toBe("INV-2042");
    expect(stops[0].invoiceFile).toBe("INV-2042.pdf");
    expect(stops[0].collections).toHaveLength(1);
    expect(stops[0].collections![0]).toMatchObject({
      collectionNo: "COL-118",
      originalInvoiceNo: "INV-1990",
    });
  });

  it("takes the credited invoice from an explicit column when the sheet has one", async () => {
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

describe('"0" and "-" mean there is none', () => {
  it.each(["0", "-"])("a COLLECTNO of %j is a plain delivery", async (blank) => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", blank, "", "3"],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ invoiceNumber: "INV-2041", invoiceFile: "INV-2041.pdf" });
    expect(stops[0].collections).toEqual([]);
    expect(result.totalCollections).toBe(0);
  });

  it.each(["0", "-"])("an INVOICENO of %j beside a COLLECTNO is an ad hoc collection", async (blank) => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Delta Trading", blank, "COL-119", "", ""],
    ]);

    const stops = result.driverResults[0].stops;
    expect(stops).toHaveLength(1);
    expect(stops[0].invoiceNumber).toBe("");
    expect(stops[0].collections![0]).toMatchObject({
      collectionNo: "COL-119",
      originalInvoiceNo: null,
    });
    expect(result.missingInvoices).toEqual([]);
  });

  it("reads a numeric 0 in an Excel COLLECTIONNO column as no collection", async () => {
    // The shape of a real depot sheet: Excel stores the 0 as a number, the
    // header is spelled COLLECTIONNO, and the invoices are IV-style PDFs.
    invoiceFiles = [invoice("IV-365-4"), invoice("IV-633291")];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["DATE", "DRIVER", "REGNO", "CUSTOMER", "INVOICENO", "COLLECTIONNO", "NOP"],
        ["2026-10-13", "John Smith", "LT70HCGP", "Newlands Auto Spares", "IV-365-4", 0, 1],
        ["2026-10-13", "John Smith", "LT70HCGP", "Bennbliss Auto", 633291, "-", 1],
      ]),
      "Trip Sheet"
    );
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const result = await parseTripSheet(TENANT, buffer, "trip.xlsx");

    expect(result.totalCollections).toBe(0);
    expect(result.driverResults[0].stops.map((s) => [s.invoiceNumber, s.invoiceFile])).toEqual([
      ["IV-365-4", "IV-365-4.pdf"],
      ["633291", "IV-633291.pdf"],
    ]);
    expect(result.missingInvoices).toEqual([]);
  });

  it.each(["COLLECTIONNO", "COLLECTION NO", "COLLECTION"])(
    "parses the PETRUS sheet as three deliveries (header %s)",
    async (collectionHeader) => {
      // Cell for cell the sheet the office reported: numeric invoice numbers,
      // a numeric 0 under the collection column, PDFs named IV-<number>.pdf.
      invoiceFiles = [invoice("IV-632981"), invoice("IV-633689"), invoice("IV-633690")];
      drivers = [{ id: "driver-p", name: "PETRUS (JHB)" }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ["Date", "Driver", "REG No", "CUSTOMER", "INVOICE NO", collectionHeader, "NOP"],
          ["13/10/2026", "PETRUS (JHB)", "MN59NDGP", "NEWLANDS AUTO SPARES", 632981, 0, 1],
          ["13/10/2026", "PETRUS (JHB)", "MN59NDGP", "BENNBLISS AUTO", 633689, 0, 1],
          ["13/10/2026", "PETRUS (JHB)", "MN59NDGP", "AUTO PRIME 5 SPARES", 633690, 0, 1],
        ]),
        "Sheet1"
      );
      const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

      const result = await parseTripSheet(TENANT, buffer, "petrus.xlsx");

      expect(result.totalCollections).toBe(0);
      expect(result.matchedInvoices).toBe(3);
      expect(result.driverResults[0].stops.map((s) => s.invoiceFile)).toEqual([
        "IV-632981.pdf",
        "IV-633689.pdf",
        "IV-633690.pdf",
      ]);
      expect(result.missingInvoices).toEqual([]);
    }
  );

  it("drops a row where both are placeholders", async () => {
    const result = await parse([
      HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Ghost Supplies", "0", "-", "", "2"],
    ]);

    expect(result.totalRows).toBe(0);
    expect(result.driverResults).toEqual([]);
  });
});

describe("matching INVOICENO to an IV-style PDF", () => {
  it.each(["IV-365-4", "INV-365-4", "INVOICE 365", "365"])("%s finds IV-365-4.pdf", async (cell) => {
    invoiceFiles = [invoice("IV-365-4"), invoice("IV-633291")];
    const result = await parse([
      LEGACY_HEADERS,
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", cell, "3"],
      ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "633291", "1"],
    ]);

    expect(result.driverResults[0].stops.map((s) => s.invoiceFile)).toEqual([
      "IV-365-4.pdf",
      "IV-633291.pdf",
    ]);
    expect(result.missingInvoices).toEqual([]);
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

  const FORMATS = ["Col 001", "001", "C001", "CO-001", "CO 001"];

  it.each(FORMATS.flatMap((sheet) => FORMATS.map((file) => [sheet, file])))(
    "COLLECTNO %s finds the document %s.pdf",
    async (sheet, file) => {
      collectionDocs = [doc(file), doc("C002")];
      const result = await parse([
        HEADERS,
        ["2026-10-13", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", sheet, "", "3"],
      ]);

      expect(result.matchedCollections).toBe(1);
      expect(result.driverResults[0].stops[0].collections![0].sourceFilePath).toBe(`${file}.pdf`);
    }
  );

  it("finds C001.pdf from an unpadded 1, and keeps C001 and C001A apart", async () => {
    collectionDocs = [doc("C001A"), doc("C001")];
    const result = await parse([
      HEADERS,
      ["2026-10-13", "John Smith", "CA 123-456", "Acme Hardware", "", "1", "", ""],
      ["2026-10-13", "John Smith", "CA 123-456", "Beta Supplies", "", "C001A", "", ""],
    ]);

    // C001A is listed first on purpose: a looser key must not let it answer
    // for "1", which is C001.
    const files = result.driverResults[0].stops.map((s) => s.collections![0].sourceFilePath);
    expect(files).toEqual(["C001.pdf", "C001A.pdf"]);
  });

  it.each(["0", "O", "o", "-", "–"])(
    "an INVOICENO with a COLLECTNO of %j is a delivery, with no collection to match",
    async (blank) => {
      const result = await parse([
        HEADERS,
        ["2026-10-13", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", blank, "", "3"],
      ]);

      expect(result.totalCollections).toBe(0);
      expect(result.driverResults[0].stops[0]).toMatchObject({
        invoiceNumber: "INV-2041",
        invoiceFile: "INV-2041.pdf",
      });
    }
  );

  it("a blank INVOICENO beside a COLLECTNO is an ad hoc collection, matched to its document", async () => {
    collectionDocs = [doc("CO-001")];
    const result = await parse([
      HEADERS,
      ["2026-10-13", "John Smith", "CA 123-456", "Delta Trading", "", "Col 001", "", ""],
    ]);

    const collection = result.driverResults[0].stops[0].collections![0];
    expect(collection).toMatchObject({ originalInvoiceNo: null, sourceFilePath: "CO-001.pdf" });
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

// ─── The client's current layout ─────────────────────────────────────────

describe("fixture: Date | Driver | REG No | CUSTOMER | INVOICE NO | COLLECTIONNO | NOP", () => {
  const CLIENT_HEADERS = ["Date", "Driver", "REG No", "CUSTOMER", "INVOICE NO", "COLLECTIONNO", "NOP"];

  it("groups a delivery row and a collection row for one customer into one stop", async () => {
    // The PDF prints INV-2026-1047; the sheet prints 1047 on both rows.
    invoiceFiles = [invoice("INV-2026-1047"), invoice("INV-2026-1050")];
    collectionDocs = [doc("COL-118")];

    const result = await parse([
      CLIENT_HEADERS,
      ["17/10/2026", "John Smith", "CA 123-456", "Acme Hardware", "1047", "", "4"],
      ["17/10/2026", "John Smith", "CA 123-456", "Beta Supplies", "1050", "0", "1"],
      ["17/10/2026", "John Smith", "CA 123-456", "Acme Hardware", "1047", "COL-118", "2"],
    ]);

    expect(result.success).toBe(true);
    expect(result.missingInvoices).toEqual([]);

    const stops = result.driverResults[0].stops;
    expect(stops.map((s) => [s.customerName, s.invoiceNumber, s.invoiceFile, s.nop])).toEqual([
      ["Acme Hardware", "1047", "INV-2026-1047.pdf", 4],
      ["Beta Supplies", "1050", "INV-2026-1050.pdf", 1],
    ]);

    // The collection row: credited against the invoice on its own row, and its
    // NOP is what to collect — not more parcels for Acme's delivery.
    expect(stops[0].collections).toHaveLength(1);
    expect(stops[0].collections![0]).toMatchObject({
      collectionNo: "COL-118",
      originalInvoiceNo: "1047",
      expectedQty: 2,
      sourceFilePath: "COL-118.pdf",
    });
    expect(stops[1].collections).toEqual([]);
  });

  it("reads NOP as the collect quantity on a collection-only stop", async () => {
    const result = await parse([
      CLIENT_HEADERS,
      ["17/10/2026", "John Smith", "CA 123-456", "Gamma Motors", "1047", "COL-119", "3"],
    ]);

    const [stop] = result.driverResults[0].stops;
    expect(stop.invoiceNumber).toBe("");
    // Nothing is being delivered here, so no parcels to hand over.
    expect(stop.nop).toBe(0);
    expect(stop.collections![0]).toMatchObject({ originalInvoiceNo: "1047", expectedQty: 3 });
  });

  it("lets an explicit COLLECTQTY win over NOP", async () => {
    const result = await parse([
      [...CLIENT_HEADERS, "COLLECTQTY"],
      ["17/10/2026", "John Smith", "CA 123-456", "Gamma Motors", "1047", "COL-119", "3", "5"],
    ]);

    expect(result.driverResults[0].stops[0].collections![0].expectedQty).toBe(5);
  });
});
