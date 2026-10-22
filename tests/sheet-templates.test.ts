/**
 * Saved import templates (lib/sheet-templates.ts): what an ADMIN may send,
 * how an upload is matched to a template, and a trip sheet in a customer's
 * own layout read end to end through the real trip parser.
 *
 * Storage and scoping are covered against a real database in
 * isolation.test.ts ("import templates"); everything here runs without one.
 */

import { describe, it, expect, vi } from "vitest";
import * as XLSX from "xlsx";

vi.mock("@/lib/invoices", () => ({
  listInvoiceFiles: vi.fn(async () => [
    { filename: "IV-900630.pdf", invoiceNumber: "900630", isSigned: false },
  ]),
}));
vi.mock("@/lib/accounts", () => ({
  listDrivers: vi.fn(async () => [{ id: "drv-1", name: "John Smith" }]),
}));
vi.mock("@/lib/collections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/collections")>();
  return {
    ...actual,
    listCollectionFolder: vi.fn(async () => ({ source: "onedrive" as const, folderPath: "/c", documents: [] })),
  };
});
vi.mock("@/lib/db-scoped", () => ({
  scopedPrisma: () => ({
    stop: { findMany: async () => [] },
    appConfig: { findUnique: async () => null },
  }),
}));

import {
  BUILT_IN_ID,
  decideTemplate,
  headerFingerprint,
  readDraftTemplate,
  readMappings,
  readPrompts,
  readTemplateInput,
  templateSnapshot,
  type SavedTemplate,
} from "@/lib/sheet-templates";
import { BUILT_IN_TRIP_SHEET, readGrid, type Grid, type SheetTemplate } from "@/lib/sheet-mapping";
import { parseTripSheet } from "@/lib/trip-parser";

// ─── A customer's own layout ──────────────────────────────────────────────

/** Title block, headers on row 3, driver printed once at the top. */
const OWN_LAYOUT: Grid = [
  ["DAILY RUN", "", "Driver:", "John Smith"],
  [],
  ["Inv Ref", "Client Name", "Boxes", "Pickup Ref"],
  ["IV-900630", "Kilo Kitchens", "2", ""],
  ["", "Lima Logistics", "1", "COL-55"],
  [],
  [],
  ["Signed for by:", "", "", ""],
];

const ownTemplate: SheetTemplate = {
  sheetType: "TRIP_SHEET",
  worksheet: null,
  headerRow: 3,
  dataStartRow: 4,
  stopAtBlankRows: 2,
  mappings: {
    invoiceNumber: { source: "column", column: "Inv Ref" },
    customerName: { source: "column", column: "Client Name" },
    nop: { source: "column", column: "Boxes" },
    collectionNo: { source: "column", column: "Pickup Ref" },
    driverName: { source: "cell", cell: "D1" },
  },
};

const saved = (overrides: Partial<SavedTemplate> & { template: SheetTemplate; headers: string[] }): SavedTemplate => ({
  id: overrides.id ?? "tpl-1",
  name: overrides.name ?? "Own layout",
  isDefault: overrides.isDefault ?? false,
  updatedAt: overrides.updatedAt ?? new Date("2026-10-01"),
  fingerprint: headerFingerprint(overrides.headers),
  template: overrides.template,
});

const ownSaved = (o: Partial<SavedTemplate> = {}) =>
  saved({ template: ownTemplate, headers: OWN_LAYOUT[2], ...o });

const STANDARD: Grid = [
  ["date", "driver", "regno", "customer", "invoiceno", "collectno", "nop"],
  ["46316", "John Smith", "XX00XXGP", "Kilo Kitchens", "900630", "0", "1"],
];

const only = (grid: Grid) => (worksheet: string | null) => (worksheet === null ? grid : null);

function xlsx(rows: Grid): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Run");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ─── Fingerprints ─────────────────────────────────────────────────────────

describe("headerFingerprint", () => {
  it("ignores case, spacing and trailing empty columns", () => {
    expect(headerFingerprint(["Inv  Ref ", "CLIENT name", "", ""])).toBe(headerFingerprint(["inv ref", "client name"]));
  });

  it("keeps a blank column in the middle — the columns after it have moved", () => {
    expect(headerFingerprint(["a", "", "b"])).not.toBe(headerFingerprint(["a", "b"]));
  });
});

// ─── Input ────────────────────────────────────────────────────────────────

describe("readMappings", () => {
  it("keeps what the reader understands and drops the rest", () => {
    const read = readMappings({
      invoiceNumber: { source: "column", column: " Inv Ref ", columnLetter: "a", fillDown: true, junk: 1 },
      courierSheetNo: { source: "filename", regex: "(\\d+)" },
      driverName: { source: "cell", cell: "d1" },
    });
    expect(read).toEqual({
      ok: true,
      mappings: {
        invoiceNumber: { source: "column", column: "Inv Ref", columnLetter: "A", fillDown: true },
        courierSheetNo: { source: "filename", regex: "(\\d+)" },
        driverName: { source: "cell", cell: "D1" },
      },
    });
  });

  it("refuses rather than drops what it cannot read", () => {
    expect(readMappings({ invoiceNumber: { source: "somewhere" } }).ok).toBe(false);
    expect(readMappings({ "bad key!": { source: "column" } }).ok).toBe(false);
    expect(readMappings({ invoiceNumber: { source: "column", splitOn: ["a long separator"] } }).ok).toBe(false);
    expect(readMappings([]).ok).toBe(false);
  });
});

describe("readTemplateInput", () => {
  const valid = {
    sheetType: "TRIP_SHEET",
    name: "Own layout",
    headerRow: 3,
    dataStartRow: 4,
    stopAtBlankRows: 2,
    mappings: ownTemplate.mappings,
    headers: OWN_LAYOUT[2],
  };

  it("accepts a complete template", () => {
    const read = readTemplateInput({ ...valid, isDefault: true });
    expect(read.ok && read.input).toMatchObject({ name: "Own layout", isDefault: true, worksheet: null, headerRow: 3 });
  });

  it("lists every problem at once", () => {
    const read = readTemplateInput({ sheetType: "INVOICE", name: "", headerRow: "x", mappings: 5 });
    expect(!read.ok && read.errors).toEqual([
      "Choose a sheet type.",
      "Give the template a name (up to 80 characters).",
      "The header row must be a row number.",
      "The first data row must be a row number.",
      "Mappings must be an object.",
      "Send the sample file's header row.",
    ]);
  });

  it("runs the template checks, so an incomplete mapping cannot be saved", () => {
    const read = readTemplateInput({ ...valid, mappings: { customerName: { source: "column", column: "Client Name" } } });
    expect(!read.ok && read.errors).toEqual(["Map at least one of: Invoice No, Collection No."]);
  });
});

describe("readDraftTemplate", () => {
  it("falls back to the detected header row and the suggestions", () => {
    const fallback = { headerRow: 3, mappings: ownTemplate.mappings };
    expect(readDraftTemplate(null, "TRIP_SHEET", fallback)).toMatchObject({ headerRow: 3, dataStartRow: 4, mappings: ownTemplate.mappings });
    expect(readDraftTemplate({ headerRow: 5, mappings: {} }, "TRIP_SHEET", fallback)).toMatchObject({ headerRow: 5, dataStartRow: 6, mappings: {} });
  });
});

describe("readPrompts", () => {
  it("keeps short string values for plausible field keys", () => {
    expect(readPrompts('{"driverName":"John Smith","x y":"no","n":5}')).toEqual({ driverName: "John Smith" });
    expect(readPrompts("not json")).toEqual({});
    expect(readPrompts(null)).toEqual({});
  });
});

// ─── Choosing ─────────────────────────────────────────────────────────────

describe("decideTemplate", () => {
  it("reads a standard sheet with the built-in layout when nothing is saved", () => {
    expect(decideTemplate("TRIP_SHEET", [], only(STANDARD))).toMatchObject({ ok: true, id: null, template: BUILT_IN_TRIP_SHEET });
  });

  it("picks the template saved for this exact layout, over the default", () => {
    const def = saved({ id: "def", isDefault: true, template: BUILT_IN_TRIP_SHEET, headers: ["other"] });
    const choice = decideTemplate("TRIP_SHEET", [def, ownSaved()], only(OWN_LAYOUT));
    expect(choice).toMatchObject({ ok: true, id: "tpl-1", name: "Own layout" });
  });

  it("breaks a tie between exact matches: default first, then the newest", () => {
    const older = ownSaved({ id: "older", updatedAt: new Date("2026-01-01") });
    const newer = ownSaved({ id: "newer", updatedAt: new Date("2026-06-01") });
    expect(decideTemplate("TRIP_SHEET", [older, newer], only(OWN_LAYOUT))).toMatchObject({ id: "newer" });
    expect(decideTemplate("TRIP_SHEET", [{ ...older, isDefault: true }, newer], only(OWN_LAYOUT))).toMatchObject({ id: "older" });
  });

  it("uses the default for a file it can read, even with different headers", () => {
    // Same columns, plus one more: not an exact match, but nothing is missing.
    const wider = OWN_LAYOUT.map((row, i) => (i === 2 ? [...row, "Notes"] : row));
    const choice = decideTemplate("TRIP_SHEET", [ownSaved({ isDefault: true })], only(wider));
    expect(choice).toMatchObject({ ok: true, id: "tpl-1" });
  });

  it("falls back to the built-in layout when the default cannot read the file but it can", () => {
    const choice = decideTemplate("TRIP_SHEET", [ownSaved({ isDefault: true })], only(STANDARD));
    expect(choice).toMatchObject({ ok: true, id: null });
  });

  it("names the default's missing columns when nothing can read the file", () => {
    const renamed: Grid = [OWN_LAYOUT[0], [], ["Invoice Ref", "Client Name", "Boxes", "Pickup Ref"], OWN_LAYOUT[3]];
    const choice = decideTemplate("TRIP_SHEET", [ownSaved({ isDefault: true })], only(renamed));
    expect(choice).toMatchObject({
      ok: false,
      code: "MISSING_COLUMNS",
      template: { id: "tpl-1", name: "Own layout" },
      missingColumns: [{ field: "invoiceNumber", label: "Invoice No", column: "Inv Ref" }],
    });
    expect(!choice.ok && choice.error).toContain('"Inv Ref" (Invoice No)');
  });

  it("lets the built-in layout report a sheet nothing can read, when there is no default", () => {
    // The parser then answers NEEDS_TEMPLATE with its long-standing message.
    expect(decideTemplate("TRIP_SHEET", [ownSaved()], only([["a", "b"], ["1", "2"]]))).toMatchObject({ ok: true, id: null });
  });

  it("reads the client's courier export with the built-in courier layout", () => {
    const courier: Grid = [["Waybillno", "Customer", "INVOICENO", "Date", "NOP"], ["700209", "Sample customer", "898714", "14/10/2026", "1"]];
    expect(decideTemplate("COURIER_TRIP_SHEET", [], only(courier))).toMatchObject({
      ok: true,
      id: null,
      name: "Built-in courier trip sheet layout",
    });
  });

  describe("asked for by id", () => {
    it("uses that template while its columns are present", () => {
      expect(decideTemplate("TRIP_SHEET", [ownSaved()], only(OWN_LAYOUT), "tpl-1")).toMatchObject({ ok: true, id: "tpl-1" });
    });

    it("refuses an id that is not one of the scope's templates", () => {
      expect(decideTemplate("TRIP_SHEET", [ownSaved()], only(OWN_LAYOUT), "someone-elses")).toMatchObject({
        ok: false,
        code: "TEMPLATE_NOT_FOUND",
      });
    });

    it("refuses when the file no longer has its columns", () => {
      expect(decideTemplate("TRIP_SHEET", [ownSaved()], only(STANDARD), "tpl-1")).toMatchObject({
        ok: false,
        code: "MISSING_COLUMNS",
      });
    });

    it("refuses when the file has no worksheet of that name", () => {
      const named = ownSaved({ template: { ...ownTemplate, worksheet: "Run" } });
      const choice = decideTemplate("TRIP_SHEET", [named], only(OWN_LAYOUT), "tpl-1");
      expect(choice).toMatchObject({ ok: false, code: "MISSING_COLUMNS", missingColumns: [] });
      expect(!choice.ok && choice.error).toContain('no worksheet called "Run"');
    });

    it("can ask for the built-in layout by name", () => {
      expect(decideTemplate("TRIP_SHEET", [ownSaved()], only(OWN_LAYOUT), BUILT_IN_ID)).toMatchObject({ ok: true, id: null });
      expect(decideTemplate("COURIER_TRIP_SHEET", [], only(STANDARD), BUILT_IN_ID)).toMatchObject({ ok: true, id: null });
    });
  });
});

describe("templateSnapshot", () => {
  it("records a saved template as it was used, and nothing for the built-in layout", () => {
    expect(templateSnapshot({ ok: true, id: "tpl-1", name: "Own layout", template: ownTemplate })).toEqual({
      id: "tpl-1",
      name: "Own layout",
      ...ownTemplate,
    });
    expect(templateSnapshot({ ok: true, id: null, name: "Built-in", template: BUILT_IN_TRIP_SHEET })).toBeUndefined();
  });
});

// ─── End to end ───────────────────────────────────────────────────────────

describe("a trip sheet in a customer's own layout", () => {
  it("deploys the same stops a standard sheet would", async () => {
    const buffer = xlsx(OWN_LAYOUT);
    const read = readGrid(buffer, "run.xlsx");
    if (!read.ok) throw new Error(read.error);
    expect(decideTemplate("TRIP_SHEET", [ownSaved()], only(read.grid))).toMatchObject({ id: "tpl-1" });

    const result = await parseTripSheet("tenant-1", buffer, "run.xlsx", { template: ownTemplate });
    expect(result.success).toBe(true);
    expect(result.driverResults).toHaveLength(1);
    expect(result.driverResults[0]).toMatchObject({ driverId: "drv-1", driverName: "John Smith" });
    expect(result.driverResults[0].stops.map((s) => [s.customerName, s.invoiceNumber, s.invoiceFile ?? null, s.nop])).toEqual([
      ["Kilo Kitchens", "IV-900630", "IV-900630.pdf", 2],
      ["Lima Logistics", "", null, 0],
    ]);
    expect(result.driverResults[0].stops[1].collections?.map((c) => [c.collectionNo, c.expectedQty])).toEqual([["COL-55", 1]]);
  });

  it("takes a value typed at import for a field the sheet does not carry", async () => {
    const noDriver = OWN_LAYOUT.map((row, i) => (i === 0 ? ["DAILY RUN"] : row));
    const typed: SheetTemplate = { ...ownTemplate, mappings: { ...ownTemplate.mappings, driverName: { source: "promptAtImport" } } };
    const result = await parseTripSheet("tenant-1", xlsx(noDriver), "run.xlsx", {
      template: typed,
      prompts: { driverName: "John Smith" },
    });
    expect(result.driverResults.map((d) => d.driverId)).toEqual(["drv-1"]);
  });

  it("refuses a template whose columns are not in the file", async () => {
    const result = await parseTripSheet("tenant-1", xlsx(STANDARD.map((r) => [...r])), "run.xlsx", {
      template: { ...ownTemplate, headerRow: 1, dataStartRow: 2 },
    });
    expect(result).toMatchObject({ success: false, code: "MISSING_COLUMNS" });
    // In field order (lib/import-fields.ts), not sheet order.
    expect(result.missingColumns?.map((m) => m.column)).toEqual(["Client Name", "Inv Ref", "Pickup Ref", "Boxes"]);
  });
});
