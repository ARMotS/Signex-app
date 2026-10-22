/**
 * The mapped sheet reader (lib/sheet-mapping.ts) and its template checks.
 *
 * Trip sheets read through the built-in layout are covered by the golden
 * snapshots in trip-sheet-golden.test.ts; this file covers what a saved
 * template can ask for — named columns, letters, cells, fill down, splitting,
 * patterns, dates — and the real courier trip sheet export.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  BUILT_IN_TRIP_SHEET,
  cellAddress,
  checkTemplate,
  columnIndex,
  detectHeaderRow,
  parseDateCell,
  parseWithTemplate,
  readGrid,
  suggestMappings,
  type Grid,
  type SheetTemplate,
} from "@/lib/sheet-mapping";
import { fieldForHeader, SHEET_TYPES } from "@/lib/import-fields";

const FIXTURES = path.join(__dirname, "fixtures", "sheets");

function courier(overrides: Partial<SheetTemplate> = {}): SheetTemplate {
  return {
    sheetType: "COURIER_TRIP_SHEET",
    worksheet: null,
    headerRow: 1,
    dataStartRow: 2,
    stopAtBlankRows: 2,
    mappings: {
      waybillNo: { source: "column", column: "Waybillno" },
      customerName: { source: "column", column: "Customer" },
      invoiceNumber: { source: "column", column: "INVOICENO" },
      invoiceDate: { source: "column", column: "Date", dateFormat: "dd/MM/yyyy" },
      parcels: { source: "column", column: "NOP" },
      courierSheetNo: { source: "promptAtImport" },
    },
    ...overrides,
  };
}

const grid = (rows: (string | number)[][]): Grid => rows.map((r) => r.map((c) => String(c)));

describe("the real courier trip sheet export", () => {
  const read = readGrid(fs.readFileSync(path.join(FIXTURES, "cts-200189-p5.xlsx")), "cts-200189-p5.xlsx");
  if (!read.ok) throw new Error(read.error);

  it("reads every invoice with its waybill, customer and date", () => {
    const sheet = parseWithTemplate(read.grid, courier(), { prompts: { courierSheetNo: "200189" } });
    expect(sheet.missingColumns).toEqual([]);
    expect(sheet.header.courierSheetNo).toBe("200189");
    expect(sheet.rows.map((r) => r.values)).toEqual([
      expect.objectContaining({ waybillNo: "700209", customerName: "Sample customer", invoiceNumber: "898714", invoiceDate: "2026-10-14", parcels: 1 }),
      expect.objectContaining({ waybillNo: "700209", invoiceNumber: "898715", invoiceDate: "2026-10-14", parcels: 0 }),
      expect.objectContaining({ waybillNo: "700209", invoiceNumber: "898716", invoiceDate: "2026-10-17", parcels: 0 }),
    ]);
    expect(sheet.issues).toEqual([]);
  });

  it("is laid out so the alias rule can suggest every column", () => {
    expect(suggestMappings(read.grid[0], "COURIER_TRIP_SHEET")).toEqual({
      waybillNo: { source: "column", column: "Waybillno", columnLetter: "A" },
      customerName: { source: "column", column: "Customer", columnLetter: "B" },
      invoiceNumber: { source: "column", column: "INVOICENO", columnLetter: "C" },
      invoiceDate: { source: "column", column: "Date", columnLetter: "D" },
      parcels: { source: "column", column: "NOP", columnLetter: "E" },
    });
  });

  it("reports a sheet number nobody typed", () => {
    const sheet = parseWithTemplate(read.grid, courier());
    expect(sheet.issues).toContainEqual({ rowNumber: null, field: "courierSheetNo", message: "Courier sheet No is required" });
  });

  describe("sheet number from the filename", () => {
    const FILENAME = "cts-200189-p5.xlsx";
    const fromFilename = (regex?: string) =>
      courier({
        mappings: { ...courier().mappings, courierSheetNo: { source: "filename", ...(regex ? { regex } : {}) } },
      });

    it("reads the export's own name with no pattern at all", () => {
      const sheet = parseWithTemplate(read.grid, fromFilename(), { filename: FILENAME });
      expect(sheet.header.courierSheetNo).toBe("200189");
      expect(sheet.issues).toEqual([]);
      expect(checkTemplate(fromFilename())).toEqual({ errors: [], warnings: [] });
    });

    it("prefers the template's pattern where it matches", () => {
      const sheet = parseWithTemplate(read.grid, fromFilename("^SHEET(\\d+)"), { filename: "SHEET77-cts-200189-p5.xlsx" });
      expect(sheet.header.courierSheetNo).toBe("77");
    });

    it("falls back to the built-in conventions where the pattern does not match", () => {
      const sheet = parseWithTemplate(read.grid, fromFilename("^SHEET(\\d+)"), { filename: FILENAME });
      expect(sheet.header.courierSheetNo).toBe("200189");
      expect(sheet.issues).toEqual([]);
    });

    it("reports a filename with no number in it", () => {
      const sheet = parseWithTemplate(read.grid, fromFilename(), { filename: "sample courier trip sheet.xlsx" });
      expect(sheet.header.courierSheetNo).toBe("");
      expect(sheet.issues.map((i) => i.message)).toEqual([
        'No sheet number found in the filename "sample courier trip sheet"',
        "Courier sheet No is required",
      ]);
    });

    it("reports a missing filename", () => {
      const sheet = parseWithTemplate(read.grid, fromFilename());
      expect(sheet.issues.map((i) => i.message)).toContain("No filename to read the sheet number from");
    });
  });
});

describe("the real trip sheet exports", () => {
  it("are recognised by header on row 1", () => {
    const read = readGrid(fs.readFileSync(path.join(FIXTURES, "ts-100002-j12.xls")), "ts-100002-j12.xls");
    if (!read.ok) throw new Error(read.error);
    expect(detectHeaderRow(read.grid, "TRIP_SHEET")).toBe(1);
    expect(Object.keys(suggestMappings(read.grid[0], "TRIP_SHEET"))).toEqual([
      "date",
      "driverName",
      "regNo",
      "customerName",
      "invoiceNumber",
      "collectionNo",
      "nop",
    ]);
  });
});

describe("finding columns", () => {
  const rows = grid([
    ["Ref", "Customer", "Ref", "Parcels"],
    ["W1", "Acme", "INV-1", 2],
  ]);

  it("matches header text ignoring case and spacing", () => {
    const sheet = parseWithTemplate(
      grid([["  customer   NAME "], ["Acme"]]),
      courier({ mappings: { customerName: { source: "column", column: "Customer Name" } } })
    );
    expect(sheet.rows[0].values.customerName).toBe("Acme");
  });

  it("uses the letter to choose between two headers with the same text", () => {
    const sheet = parseWithTemplate(
      rows,
      courier({
        mappings: {
          waybillNo: { source: "column", column: "Ref", columnLetter: "A" },
          invoiceNumber: { source: "column", column: "Ref", columnLetter: "C" },
        },
      })
    );
    expect(sheet.rows[0].values).toMatchObject({ waybillNo: "W1", invoiceNumber: "INV-1" });
  });

  it("reads by letter when the header is blank", () => {
    const sheet = parseWithTemplate(
      grid([["", "x"], ["INV-9", "y"]]),
      courier({ mappings: { invoiceNumber: { source: "column", columnLetter: "A" } } })
    );
    expect(sheet.rows[0].values.invoiceNumber).toBe("INV-9");
  });

  it("reports a renamed column as missing rather than reading what sits under its old letter", () => {
    const sheet = parseWithTemplate(
      rows,
      courier({ mappings: { parcels: { source: "column", column: "NOP", columnLetter: "D" } } })
    );
    expect(sheet.missingColumns).toEqual([{ field: "parcels", label: "Parcels", column: "NOP" }]);
    expect(sheet.rows[0].values.parcels).toBe(0);
  });

  it("lets a built-in layout's explicit mapping override its aliases", () => {
    const sheet = parseWithTemplate(
      grid([["Customer", "Invoice", "Real Customer"], ["Wrong", "INV-1", "Right"]]),
      { ...BUILT_IN_TRIP_SHEET, mappings: { customerName: { source: "column", column: "Real Customer" } } }
    );
    expect(sheet.rows[0].values.customerName).toBe("Right");
  });

  it("falls back to the row naming the most fields, then to row 1", () => {
    const ownHeaders = grid([
      ["DAILY RUN", "", "Driver:", "Jane"],
      [],
      ["Inv Ref", "Client Name", "Boxes"],
      ["IV-1", "Kilo", "2"],
    ]);
    expect(detectHeaderRow(ownHeaders, "TRIP_SHEET")).toBe(3);
    expect(detectHeaderRow(grid([["a", "b"], ["1", "2"]]), "TRIP_SHEET")).toBe(1);
  });

  it("finds the header row under a title block", () => {
    const sheet = grid([
      ["COURIER TRIP SHEET 200189"],
      ["", "", "21/10/2026"],
      [],
      ["Waybill No:", "Customer", "Invoice No.", "Date", "NO of Parcels"],
      ["700209", "Sample customer", "898714", "14/10/2026", "1"],
    ]);
    expect(detectHeaderRow(sheet, "COURIER_TRIP_SHEET")).toBe(4);
    expect(Object.keys(suggestMappings(sheet[3], "COURIER_TRIP_SHEET"))).toEqual([
      "waybillNo",
      "customerName",
      "invoiceNumber",
      "invoiceDate",
      "parcels",
    ]);
  });
});

describe("cells and sheet-level values", () => {
  const titled = grid([
    ["COURIER TRIP SHEET 200189", "", "", "", ""],
    ["Waybill", "Customer", "Invoice", "Date", "NOP"],
    ["700209", "Sample customer", "898714", "14/10/2026", "1"],
    ["", "", "", "", ""],
    ["", "", "", "", ""],
    ["Received in good order", "", "", "", ""],
  ]);
  const base = (mappings: SheetTemplate["mappings"]) =>
    courier({
      headerRow: 2,
      dataStartRow: 3,
      mappings: {
        waybillNo: { source: "column", column: "Waybill" },
        customerName: { source: "column", column: "Customer" },
        invoiceNumber: { source: "column", column: "Invoice" },
        ...mappings,
      },
    });

  it("pulls a number out of a title cell with a pattern", () => {
    const sheet = parseWithTemplate(titled, base({ courierSheetNo: { source: "cell", cell: "A1", regex: "SHEET\\s+(\\d+)" } }));
    expect(sheet.header.courierSheetNo).toBe("200189");
  });

  it("takes a header field from a column's first value", () => {
    const sheet = parseWithTemplate(titled, base({ sheetDate: { source: "firstValueInColumn", column: "Date" } }));
    expect(sheet.header.sheetDate).toBe("2026-10-14");
  });

  it("applies a typed value to every row of a column field", () => {
    const sheet = parseWithTemplate(
      grid([["Invoice"], ["A1"], ["A2"]]),
      { ...BUILT_IN_TRIP_SHEET, mappings: { driverName: { source: "promptAtImport" } } },
      { prompts: { driverName: "John Smith" } }
    );
    expect(sheet.rows.map((r) => r.values.driverName)).toEqual(["John Smith", "John Smith"]);
  });

  it("stops at the footer after enough blank rows", () => {
    const sheet = parseWithTemplate(titled, base({}));
    expect(sheet.rows.map((r) => r.values.waybillNo)).toEqual(["700209"]);
  });

  it("reads past blank rows when told not to stop", () => {
    const sheet = parseWithTemplate(titled, { ...base({}), stopAtBlankRows: 0 });
    expect(sheet.rows.map((r) => r.values.waybillNo)).toEqual(["700209", "Received in good order"]);
  });

  it("refuses a pattern that could backtrack, and reads the field as blank", () => {
    const sheet = parseWithTemplate(titled, base({ courierSheetNo: { source: "cell", cell: "A1", regex: "(\\d)+" } }));
    expect(sheet.header.courierSheetNo).toBe("");
    expect(sheet.issues[0]).toMatchObject({ rowNumber: null, field: "courierSheetNo" });
  });
});

describe("fill down and splitting", () => {
  it("fills a blank cell from the row above", () => {
    const sheet = parseWithTemplate(
      grid([["Waybill", "Invoice"], ["700209", "A"], ["", "B"], ["700210", "C"]]),
      courier({
        mappings: {
          waybillNo: { source: "column", column: "Waybill", fillDown: true },
          invoiceNumber: { source: "column", column: "Invoice" },
        },
      })
    );
    expect(sheet.rows.map((r) => r.values.waybillNo)).toEqual(["700209", "700209", "700210"]);
  });

  it("turns a cell listing several invoices into a row each", () => {
    const sheet = parseWithTemplate(
      grid([["Waybill", "Invoice"], ["700209", "898714 / 899947, 899977;-"]]),
      courier({
        mappings: {
          waybillNo: { source: "column", column: "Waybill" },
          invoiceNumber: { source: "column", column: "Invoice", splitOn: [",", "/", ";"] },
        },
      })
    );
    // The "-" piece is a placeholder, read as blank and reported as missing.
    expect(sheet.rows.map((r) => [r.rowNumber, r.values.waybillNo, r.values.invoiceNumber])).toEqual([
      [2, "700209", "898714"],
      [2, "700209", "899947"],
      [2, "700209", "899977"],
      [2, "700209", ""],
    ]);
    expect(sheet.issues).toContainEqual({ rowNumber: 2, field: "invoiceNumber", message: "Invoice No is required" });
  });
});

describe("dates", () => {
  it("reads an Excel serial", () => {
    expect(parseDateCell("46316")).toBe("2026-10-21");
  });

  it("reads day-first text by default", () => {
    expect(parseDateCell("14/10/2026")).toBe("2026-10-14");
    expect(parseDateCell("4-1-26")).toBe("2026-01-04");
    expect(parseDateCell("14/10/2026 08:30")).toBe("2026-10-14");
  });

  it("reads ISO", () => {
    expect(parseDateCell("2026-10-14")).toBe("2026-10-14");
  });

  it("follows the template's format", () => {
    expect(parseDateCell("10/14/2026", "MM/dd/yyyy")).toBe("2026-10-14");
    expect(parseDateCell("2026.10.14", "yyyy.MM.dd")).toBe("2026-10-14");
  });

  it("refuses dates that do not exist", () => {
    expect(parseDateCell("31/02/2026")).toBeNull();
    expect(parseDateCell("hello")).toBeNull();
  });

  it("reports an unreadable date on its row", () => {
    const sheet = parseWithTemplate(
      grid([["Invoice", "Date"], ["A", "soon"]]),
      courier({ mappings: { invoiceNumber: { source: "column", column: "Invoice" }, invoiceDate: { source: "column", column: "Date" } } })
    );
    expect(sheet.rows[0].values.invoiceDate).toBeNull();
    expect(sheet.issues).toContainEqual({ rowNumber: 2, field: "invoiceDate", message: '"soon" is not a date' });
  });
});

describe("addresses", () => {
  it("reads column letters and cell references", () => {
    expect(columnIndex("A")).toBe(0);
    expect(columnIndex("ab")).toBe(27);
    expect(columnIndex("A1")).toBeNull();
    expect(cellAddress("F2")).toEqual({ row: 1, col: 5 });
    expect(cellAddress("2F")).toBeNull();
  });
});

describe("reading a workbook", () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["first"]]), "One");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["second"]]), "Two");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  it("reads the named worksheet", () => {
    const read = readGrid(buffer, "book.xlsx", "Two");
    expect(read.ok && read.grid).toEqual([["second"]]);
    expect(read.ok && read.sheetNames).toEqual(["One", "Two"]);
  });

  it("names the worksheets when the one asked for is not there", () => {
    const read = readGrid(buffer, "book.xlsx", "Three");
    expect(read.ok).toBe(false);
    expect(!read.ok && read.error).toContain("One, Two");
  });
});

describe("checkTemplate", () => {
  it("passes the built-in trip sheet layout and a complete courier template", () => {
    expect(checkTemplate(BUILT_IN_TRIP_SHEET)).toEqual({ errors: [], warnings: [] });
    expect(checkTemplate(courier())).toEqual({ errors: [], warnings: [] });
  });

  it("names every required field left unmapped", () => {
    const { errors } = checkTemplate(courier({ mappings: {} }));
    expect(errors).toEqual(
      expect.arrayContaining([
        "Invoice No must be mapped.",
        "Waybill No must be mapped.",
        "Customer must be mapped.",
        "Courier sheet No must be mapped.",
      ])
    );
  });

  it("needs an invoice or a collection column on a trip sheet", () => {
    const { errors } = checkTemplate({
      ...BUILT_IN_TRIP_SHEET,
      matchAliases: false,
      mappings: { customerName: { source: "column", column: "Customer" } },
    });
    expect(errors).toContain("Map at least one of: Invoice No, Collection No.");
  });

  it("refuses incomplete or contradictory mappings", () => {
    const { errors } = checkTemplate(
      courier({
        headerRow: 3,
        dataStartRow: 3,
        mappings: {
          ...courier().mappings,
          waybillNo: { source: "column", columnLetter: "A1" },
          customerName: { source: "cell", cell: "nowhere" },
          courierSheetNo: { source: "column", column: "Sheet" },
          invoiceNumber: { source: "column", column: "Invoice", splitOn: [","] },
          parcels: { source: "column", column: "NOP", splitOn: ["/"], dateFormat: "dd/MM/yyyy" },
          invoiceDate: { source: "column", column: "Date", dateFormat: "dd/yyyy" },
          courierCompany: { source: "cell", cell: "B2", regex: "(\\w)+", fillDown: true },
        },
      })
    );
    // Order follows the mappings object, which is not the point here.
    expect([...errors].sort()).toEqual([
      "Data must start below the header row.",
      'Waybill No: "A1" is not a column letter.',
      "Waybill No: choose a column.",
      "Customer: choose a cell, e.g. F2.",
      "Courier sheet No is one value per sheet: choose a cell, the column's first value, or type it at import.",
      "Parcels is not a date.",
      'Invoice date: "dd/yyyy" needs a day (dd), month (MM) and year (yyyy).',
      "Courier company: fill down needs a column.",
      "Courier company: A group cannot be repeated — put the quantifier inside it: (\\d+), not (\\d)+.",
      "Only one field can be split into several rows.",
    ].sort());
  });

  it("warns when one column feeds two fields", () => {
    const { errors, warnings } = checkTemplate(
      courier({ mappings: { ...courier().mappings, courierService: { source: "firstValueInColumn", column: "customer" } } })
    );
    expect(errors).toEqual([]);
    expect(warnings).toEqual(["One column is mapped to Customer and Courier service."]);
  });
});

describe("the field registry", () => {
  it("gives every field a unique key per sheet type", () => {
    for (const definition of Object.values(SHEET_TYPES)) {
      const keys = definition.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("gives an ambiguous header to the earlier field, as the trip parser always has", () => {
    expect(fieldForHeader("Collection", "TRIP_SHEET")).toBe("collectionNo");
    expect(fieldForHeader("Original Invoice", "TRIP_SHEET")).toBe("originalInvoiceNo");
    expect(fieldForHeader("Qty", "TRIP_SHEET")).toBe("nop");
  });
});
