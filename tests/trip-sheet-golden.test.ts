/**
 * Golden output of the trip sheet reader.
 *
 * Recorded against the parser BEFORE it moved onto import templates
 * (lib/sheet-mapping.ts), so the snapshots are what "existing uploads parse
 * identically" means in practice. A snapshot that changes here is a change in
 * what a depot's sheet deploys, not a formatting detail — update one only on
 * purpose, and say why in the commit.
 *
 * The three .xls files in tests/fixtures/sheets are the client's own exports
 * (written by Visual FoxPro: BIFF5, lowercase headers, Excel serial dates,
 * numeric invoice cells, "0" in collectno), anonymised in place — customer,
 * driver and vehicle strings swapped for same-length placeholders and invoice
 * numbers moved to 9xxxxx inside the existing records, so every record the
 * writer produced (including ones SheetJS does not know) is still there. The
 * snapshots were checked against the pre-refactor output under the same
 * substitution: identical. The synthetic sheets cover
 * the quirks those files do not: alias spellings, column order, placeholders,
 * blank rows, duplicate headers, CSV, sparse cells and the error paths.
 *
 * Everything the parser reaches out to is stubbed, as in
 * trip-parser-collections.test.ts, so this needs no database or OneDrive.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";

let invoiceFiles: { filename: string; invoiceNumber: string; isSigned: boolean; signedAt?: string }[] = [];
let drivers: { id: string; name: string }[] = [];

vi.mock("@/lib/invoices", () => ({
  listInvoiceFiles: vi.fn(async () => invoiceFiles),
}));

vi.mock("@/lib/accounts", () => ({
  listDrivers: vi.fn(async () => drivers),
}));

vi.mock("@/lib/collections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/collections")>();
  return {
    ...actual,
    listCollectionFolder: vi.fn(async () => ({
      source: "onedrive" as const,
      folderPath: "/Signex/Collections",
      documents: [
        {
          filename: "COL-118.pdf",
          name: "COL-118",
          collectionNo: "COL-118",
          sizeBytes: 1024,
          lastModified: "2026-10-01T00:00:00.000Z",
          itemId: "item-COL-118",
        },
      ],
    })),
  };
});

vi.mock("@/lib/db-scoped", () => ({
  scopedPrisma: () => ({
    stop: { findMany: async () => [] },
    appConfig: { findUnique: async () => null },
  }),
}));

import { parseTripSheet } from "@/lib/trip-parser";

const TENANT = "tenant-1";
const FIXTURES = path.join(__dirname, "fixtures", "sheets");

/** Stop and collection ids are random UUIDs; label them in order of appearance. */
function stableIds<T>(value: T): T {
  const seen = new Map<string, string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v === "string" && uuid.test(v)) {
        if (!seen.has(v)) seen.set(v, `<id-${seen.size + 1}>`);
        return seen.get(v);
      }
      return v;
    })
  );
}

type Cell = string | number | null;

function xlsx(sheets: Record<string, Cell[][]>, bookType: XLSX.BookType = "xlsx"): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType }) as Buffer;
}

async function golden(buffer: Buffer, filename: string) {
  return stableIds(await parseTripSheet(TENANT, buffer, filename));
}

beforeEach(() => {
  drivers = [
    { id: "drv-jhb", name: "DRIVER (JHB)" },
    { id: "drv-john", name: "John Smith" },
  ];
  invoiceFiles = [
    { filename: "IV-900630.pdf", invoiceNumber: "900630", isSigned: false },
    { filename: "IV-900627.pdf", invoiceNumber: "900627", isSigned: false },
    { filename: "900986.pdf", invoiceNumber: "900986", isSigned: false },
    { filename: "IV-900933.pdf", invoiceNumber: "900933", isSigned: true, signedAt: "2026-10-20T08:00:00.000Z" },
    { filename: "INV-2041.pdf", invoiceNumber: "INV-2041", isSigned: false },
    { filename: "INV-2043.pdf", invoiceNumber: "INV-2043", isSigned: false },
  ];
});

describe("trip sheet golden output — real exports", () => {
  for (const name of ["ts-100001-p5.xls", "ts-100002-j12.xls", "ts-100003-c2.xls"]) {
    it(name, async () => {
      const buffer = fs.readFileSync(path.join(FIXTURES, name));
      expect(await golden(buffer, name)).toMatchSnapshot();
    });
  }
});

describe("trip sheet golden output — synthetic", () => {
  it("alias spellings, every optional column", async () => {
    const buffer = xlsx({
      Run: [
        ["Trip Date", "Driver Name", "Reg No.", "Client", "Invoice #", "Collection No", "Collection Type", "Original Invoice", "Collect Qty", "Parcels"],
        ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", "", "", "", "", 3],
        ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-2042", "COL-118", "Credit Return", "", "", 2],
        ["2026-08-24", "John Smith", "CA 123-456", "Delta Trading", "", "COL-119", "Crates", "", 4, 0],
        ["2026-08-24", "John Smith", "CA 123-456", "Echo Ltd", "0", "COL-120", "uplift", "INV-1999", "", 5],
        ["2026-08-24", "Thandi Nkosi", "CJ 998-221", "Cape Fittings", "INV-2043", "-", "", "", "", 12],
      ],
    });
    expect(await golden(buffer, "aliases.xlsx")).toMatchSnapshot();
  });

  it("INVOICENO in column A, placeholders, padding, blank rows, deferred collection", async () => {
    const buffer = xlsx({
      Sheet1: [
        ["INVOICENO", "  NOP  ", "COLLECTNO", "Driver", "Customer"],
        ["N/A", 1, "COL-200", "John Smith", "Foxtrot Co"],
        [null, null, null, null, null],
        ["  INV-3001  ", " 2 ", "0", " John Smith ", "  Golf Garage  "],
        ["O", 0, "NIL", "John Smith", "Nobody"],
        [null, null, null, null, null],
        [null, null, null, null, null],
        ["INV-3002", "abc", "", "John Smith", "Foxtrot Co"],
        ["INV-3003", "3.7", "NONE", "Unknown Driver", ""],
        ["", "", "COL-201", "", ""],
      ],
    });
    expect(await golden(buffer, "column-a.xlsx")).toMatchSnapshot();
  });

  it("duplicate and unknown headers — first match wins", async () => {
    const buffer = xlsx({
      Sheet1: [
        ["Customer", "Notes", "Company", "Invoice No", "Invoice", "Driver", "Qty", "NOP", null, "Vehicle"],
        ["First Cust", "x", "Second Cust", "INV-4001", "INV-9999", "John Smith", 7, 9, "stray", "AB 12 CD"],
        ["Hotel Hardware", "", "Other", "INV-4002", "", "John Smith", "", 1, "", "AB 12 CD"],
      ],
    });
    expect(await golden(buffer, "duplicates.xlsx")).toMatchSnapshot();
  });

  it("legacy sheet with no COLLECTNO column", async () => {
    const buffer = xlsx({
      Sheet1: [
        ["Date", "Driver", "REGNO", "Customer", "INVOICENO", "NOP"],
        [46316, "John Smith", "CA 1", "India Imports", 900986, 2],
        [46316, "John Smith", "CA 1", "Juliet Joinery", 900987, 0],
      ],
    });
    expect(await golden(buffer, "legacy.xlsx")).toMatchSnapshot();
  });

  it("reads only the first worksheet", async () => {
    const buffer = xlsx({
      First: [
        ["Customer", "INVOICENO", "Driver"],
        ["Kilo Kitchens", "INV-5001", "John Smith"],
      ],
      Second: [
        ["Customer", "INVOICENO", "Driver"],
        ["Never Read", "INV-5002", "John Smith"],
      ],
    });
    expect(await golden(buffer, "two-sheets.xlsx")).toMatchSnapshot();
  });

  it("legacy .xls (BIFF8) written by SheetJS", async () => {
    const buffer = xlsx(
      {
        Sheet1: [
          ["date", "driver", "regno", "customer", "invoiceno", "collectno", "nop"],
          [46316, "DRIVER (JHB)", "XX00XXGP", "Lima Logistics", 900630, 0, 1],
          [46316, "DRIVER (JHB)", "XX00XXGP", "Lima Logistics", 900627, "COL-118", 0],
        ],
      },
      "biff8"
    );
    expect(await golden(buffer, "biff8.xls")).toMatchSnapshot();
  });

  it("CSV with quotes, CRLF and a blank line", async () => {
    const csv = [
      "Date,Driver,REGNO,Customer,INVOICENO,COLLECTNO,NOP",
      '2026-08-24,John Smith,CA 1,"Mike, Sons & Co",INV-6001,,3',
      "",
      "2026-08-24,John Smith,CA 1,November Nuts,INV-6002,COL-118,1",
      "2026-08-24,,,Oscar Oils,-,0,0",
    ].join("\r\n");
    expect(await golden(Buffer.from(csv, "utf-8"), "run.csv")).toMatchSnapshot();
  });

  it("uppercase extension is read", async () => {
    // Recorded as-is: the extension check is case-folded, so .XLSX is read.
    const buffer = xlsx({ S: [["INVOICENO", "Customer"], ["INV-7001", "Papa Paints"]] });
    expect(await golden(buffer, "RUN.XLSX")).toMatchSnapshot();
  });
});

describe("trip sheet golden output — errors", () => {
  it("no invoice or collection column", async () => {
    const buffer = xlsx({ S: [["Customer", "Driver", "Amount"], ["Quebec", "John Smith", 10]] });
    expect(await golden(buffer, "no-key.xlsx")).toMatchSnapshot();
  });

  it("header row only", async () => {
    const buffer = xlsx({ S: [["INVOICENO", "Customer"]] });
    expect(await golden(buffer, "empty.xlsx")).toMatchSnapshot();
  });

  it("unsupported file type", async () => {
    expect(await golden(Buffer.from("%PDF-1.4"), "run.pdf")).toMatchSnapshot();
  });

  it("every row blank after the header", async () => {
    const buffer = xlsx({ S: [["INVOICENO", "Customer"], [null, null], ["0", "Romeo"]] });
    expect(await golden(buffer, "blank.xlsx")).toMatchSnapshot();
  });
});
