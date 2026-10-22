/**
 * sheet-mapping.ts
 * Reads a spreadsheet through an import template: which worksheet, which row
 * holds the headers, and which column (or cell) each Signex field comes from.
 *
 * One reader for every sheet type. It knows nothing about stops, collections
 * or couriers — it turns a grid into rows of field values (plus a few
 * sheet-level values) and reports what it could not read. What a row MEANS is
 * left to the caller: lib/trip-parser.ts groups trip sheet rows into stops
 * exactly as it always has.
 *
 * The fields themselves are listed in lib/import-fields.ts.
 *
 * Templates come from two places:
 *   - built-in layouts, defined in code. BUILT_IN_TRIP_SHEET finds its columns
 *     by alias, the way the trip parser always has, so every sheet that
 *     imported before templates existed imports the same way now — including
 *     the depots that write "Coll No" instead of COLLECTNO. A layout pinned to
 *     one header spelling could not promise that.
 *   - templates an ADMIN saves for their own layout, which name each column.
 *
 * Patterns in a template run server-side on a shared instance, so they are
 * held to the invoice-number pattern rules (unsafePatternReason) and capped in
 * what they are run against.
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";
import {
  fieldForHeader,
  fieldsFor,
  isPlaceholderCell,
  normalizeHeader,
  SHEET_TYPES,
  type FieldValueType,
  type ImportField,
  type ImportSheetType,
} from "./import-fields";
import { unsafePatternReason } from "./invoice-number";
import { filenameStem, readSheetFilename } from "./sheet-filename";

// ─── Templates ────────────────────────────────────────────────────────────

/**
 * `filename` reads the sheet number from the uploaded file's name — the
 * client's Trip application puts it there (cts-200189-p5), not in the sheet.
 * A template's own pattern is tried first; where it does not match (or there
 * is none) the built-in conventions in lib/sheet-filename.ts are.
 */
export type FieldSource = "column" | "cell" | "firstValueInColumn" | "promptAtImport" | "filename";

export interface FieldMapping {
  source: FieldSource;
  /** Header text as the sheet shows it, e.g. "Waybill No:". Preferred. */
  column?: string;
  /** Column letter, used when the header is blank — or, when the header text
   *  appears twice, to say which of the two is meant. */
  columnLetter?: string;
  /** A fixed cell, e.g. "F2", for a value printed once on the sheet. */
  cell?: string;
  /** A blank cell takes the value above it (merged cells, a value written on
   *  the first row of a group only). */
  fillDown?: boolean;
  /** One cell lists several values — each becomes its own row. */
  splitOn?: string[];
  /** e.g. "dd/MM/yyyy". Excel serial dates are read without one. */
  dateFormat?: string;
  /** Pulls the value out of a longer cell: group `num`, else the first group,
   *  else the whole match. "COURIER TRIP SHEET 106189" with (\d+) → 106189. */
  regex?: string;
}

export interface SheetTemplate {
  sheetType: ImportSheetType;
  /** null reads the first worksheet. */
  worksheet: string | null;
  /** 1-based row holding the column headers. */
  headerRow: number;
  /** 1-based first row of data. */
  dataStartRow: number;
  /** Stop after this many blank rows in a row (a footer usually follows the
   *  table). 0 reads to the end, skipping blank rows. */
  stopAtBlankRows: number;
  mappings: Record<string, FieldMapping>;
  /**
   * Built-in layouts only: a field with no mapping of its own is found by its
   * aliases. A saved template names its columns instead, so that a column
   * renamed in the export is reported missing rather than silently re-guessed.
   */
  matchAliases?: boolean;
}

/** The trip sheet layout Signex has always read. See the module comment. */
export const BUILT_IN_TRIP_SHEET: SheetTemplate = {
  sheetType: "TRIP_SHEET",
  worksheet: null,
  headerRow: 1,
  dataStartRow: 2,
  stopAtBlankRows: 0,
  mappings: {},
  matchAliases: true,
};

/**
 * The courier trip sheet the client's Trip application exports: a flat table
 * (Waybillno | Customer | INVOICENO | Date | NOP) with the sheet number in the
 * filename only (cts-200189-p5.xlsx) and no courier named anywhere — so the
 * courier company is asked for at import. Columns by alias, as above.
 */
export const BUILT_IN_COURIER_TRIP_SHEET: SheetTemplate = {
  sheetType: "COURIER_TRIP_SHEET",
  worksheet: null,
  headerRow: 1,
  dataStartRow: 2,
  stopAtBlankRows: 2,
  mappings: {
    courierSheetNo: { source: "filename" },
    courierCompany: { source: "promptAtImport" },
  },
  matchAliases: true,
};

// ─── Reading a file ───────────────────────────────────────────────────────

/**
 * A sheet as rows of cell text. Rows from Excel may be sparse (an empty cell
 * is a hole, not ""), exactly as SheetJS returns them; everything below reads
 * a cell as `String(cell ?? "")`.
 */
export type Grid = string[][];

export type GridResult =
  | { ok: true; grid: Grid; sheetNames: string[]; worksheet: string | null }
  | { ok: false; error: string };

/**
 * Read an uploaded CSV or Excel file into a grid. May throw on a corrupt file;
 * callers report that as a parse failure.
 */
export function readGrid(buffer: Buffer, filename: string, worksheet: string | null = null): GridResult {
  const ext = filename.toLowerCase().split(".").pop();

  if (ext === "csv") {
    const result = Papa.parse<string[]>(buffer.toString("utf-8"), { skipEmptyLines: true });
    return { ok: true, grid: result.data, sheetNames: [], worksheet: null };
  }

  if (ext === "xlsx" || ext === "xls") {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const name = worksheet ?? workbook.SheetNames[0];
    if (worksheet !== null && !workbook.Sheets[worksheet]) {
      return {
        ok: false,
        error: `The workbook has no worksheet called "${worksheet}". It has: ${workbook.SheetNames.join(", ")}`,
      };
    }
    const data = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[name], { header: 1 });
    return {
      ok: true,
      grid: data.map((row) => row.map((cell) => String(cell ?? ""))),
      sheetNames: workbook.SheetNames,
      worksheet: name,
    };
  }

  return { ok: false, error: `Unsupported file type: .${ext}. Use CSV or Excel (.xlsx/.xls)` };
}

// ─── Addresses ────────────────────────────────────────────────────────────

/** "A" → 0, "AB" → 27. Null for anything that is not a column letter. */
export function columnIndex(letter: string): number | null {
  const v = String(letter ?? "").trim().toUpperCase();
  return /^[A-Z]{1,3}$/.test(v) ? XLSX.utils.decode_col(v) : null;
}

export function columnLetter(index: number): string {
  return XLSX.utils.encode_col(index);
}

/** "F2" → { row: 1, col: 5 } (0-based). Null for anything else. */
export function cellAddress(ref: string): { row: number; col: number } | null {
  const m = /^([A-Z]{1,3})([1-9]\d{0,6})$/i.exec(String(ref ?? "").trim());
  if (!m) return null;
  return { row: Number(m[2]) - 1, col: XLSX.utils.decode_col(m[1].toUpperCase()) };
}

// ─── Columns ──────────────────────────────────────────────────────────────

const isBlankCell = (cell: string | undefined) => !cell || cell.trim() === "";

const isBlankRow = (row: string[] | undefined) =>
  !row || !row.some((cell) => cell && cell.trim() !== "");

/**
 * Columns found by alias: each header goes to the first field it names, and
 * each field keeps the first header that names it.
 */
export function aliasColumns(headers: string[], sheetType: ImportSheetType): Record<string, number> {
  const mapping: Record<string, number> = {};
  headers.forEach((header, index) => {
    if (!header) return;
    const field = fieldForHeader(header, sheetType);
    if (field && !(field in mapping)) mapping[field] = index;
  });
  return mapping;
}

/**
 * Where a mapping's column is. By header text when it names one — and then
 * ONLY by header text: a column renamed or dropped from the export is missing,
 * not quietly read from whatever now sits under the old letter.
 */
function locateColumn(headers: string[], mapping: FieldMapping): number | null {
  const wanted = normalizeHeader(mapping.column ?? "");
  if (wanted) {
    const matches: number[] = [];
    for (let i = 0; i < headers.length; i++) {
      if (normalizeHeader(headers[i] ?? "") === wanted) matches.push(i);
    }
    if (matches.length === 0) return null;
    const at = mapping.columnLetter ? columnIndex(mapping.columnLetter) : null;
    return at !== null && matches.includes(at) ? at : matches[0];
  }
  return mapping.columnLetter ? columnIndex(mapping.columnLetter) : null;
}

export interface MissingColumn {
  field: string;
  label: string;
  /** What the template looks for: header text, else the column letter. */
  column: string;
}

/**
 * Where each column field of a template is in this header row, and which of
 * its mapped columns the row does not have. Aliases first (built-in layouts),
 * then explicit mappings on top.
 */
export function resolveColumns(
  headers: string[],
  template: SheetTemplate
): { columns: Record<string, number>; missingColumns: MissingColumn[] } {
  const columns: Record<string, number> = template.matchAliases
    ? aliasColumns(headers, template.sheetType)
    : {};
  const missingColumns: MissingColumn[] = [];
  for (const field of fieldsFor(template.sheetType)) {
    const mapping = template.mappings[field.key];
    if (!mapping || (mapping.source !== "column" && mapping.source !== "firstValueInColumn")) continue;
    const index = locateColumn(headers, mapping);
    if (index === null) {
      delete columns[field.key];
      missingColumns.push({
        field: field.key,
        label: field.label,
        column: mapping.column?.trim() || mapping.columnLetter || "",
      });
    } else {
      columns[field.key] = index;
    }
  }
  return { columns, missingColumns };
}

/** Wizard suggestions for a header row: the built-in alias rule, as mappings. */
export function suggestMappings(
  headers: string[],
  sheetType: ImportSheetType
): Record<string, FieldMapping> {
  const suggestions: Record<string, FieldMapping> = {};
  for (const [field, index] of Object.entries(aliasColumns(headers, sheetType))) {
    suggestions[field] = {
      source: "column",
      column: String(headers[index] ?? "").trim(),
      columnLetter: columnLetter(index),
    };
  }
  return suggestions;
}

/**
 * The 1-based row that looks like the header row — the wizard's first guess,
 * which the ADMIN can change. The first of the top rows in which at least
 * three cells name a field of this sheet type; failing that, the row naming
 * the most (a customer's own headers may share only one name with ours, under
 * a title block); row 1 when no row names any.
 */
export function detectHeaderRow(grid: Grid, sheetType: ImportSheetType, scanRows = 30): number {
  let best = { row: 1, hits: 0 };
  for (let r = 0; r < Math.min(scanRows, grid.length); r++) {
    const fields = new Set<string>();
    for (const cell of grid[r] ?? []) {
      const field = cell ? fieldForHeader(cell, sheetType) : null;
      if (field) fields.add(field);
    }
    if (fields.size >= 3) return r + 1;
    if (fields.size > best.hits) best = { row: r + 1, hits: fields.size };
  }
  return best.row;
}

// ─── Values ───────────────────────────────────────────────────────────────

export type MappedValue = string | number | null;

/** Longest cell a template pattern is run against. */
const PATTERN_CELL_MAX_LENGTH = 200;
const PATTERN_MAX_LENGTH = 200;

/** Compile a template's pattern, or say why not. */
export function compileTemplatePattern(
  source: string
): { ok: true; pattern: RegExp } | { ok: false; error: string } {
  const trimmed = String(source ?? "").trim();
  if (trimmed.length > PATTERN_MAX_LENGTH) {
    return { ok: false, error: `Keep the pattern under ${PATTERN_MAX_LENGTH} characters.` };
  }
  const unsafe = unsafePatternReason(trimmed);
  if (unsafe) return { ok: false, error: unsafe };
  try {
    return { ok: true, pattern: new RegExp(trimmed, "i") };
  } catch (err) {
    return { ok: false, error: `Not a valid pattern: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** What a pattern pulls out of a value: group `num`, else the first group, else the whole match. */
function matchPattern(pattern: RegExp, input: string): string | null {
  if (input.length > PATTERN_CELL_MAX_LENGTH) return null;
  const m = pattern.exec(input);
  return m ? (m.groups?.num ?? m[1] ?? m[0]) : null;
}

function emptyValue(type: FieldValueType): MappedValue {
  switch (type) {
    case "count":
      return 0;
    case "quantity":
    case "date":
      return null;
    default:
      return "";
  }
}

function isEmptyValue(value: MappedValue): boolean {
  return value === null || value === "";
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null; // 31/02
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** A date format ("dd/MM/yyyy") as a pattern with named parts, or null. */
function formatPattern(format: string): RegExp | null {
  let source = "";
  let rest = format.trim();
  const parts = new Set<string>();
  while (rest) {
    const token = /^(yyyy|yy|MM|M|dd|d)/.exec(rest)?.[1];
    if (token) {
      const part = token[0] === "y" ? "y" : token[0] === "M" ? "m" : "d";
      if (parts.has(part)) return null;
      parts.add(part);
      source += `(?<${part}>\\d{${token === "yyyy" ? "4" : token === "yy" ? "2" : "1,2"}})`;
      rest = rest.slice(token.length);
    } else {
      source += rest[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rest = rest.slice(1);
    }
  }
  return parts.size === 3 ? new RegExp(`^${source}(?:[ T].*)?$`) : null;
}

/** True when a date format names a day, a month and a year exactly once. */
export function isValidDateFormat(format: string): boolean {
  return formatPattern(format) !== null;
}

/**
 * A date cell as YYYY-MM-DD, or null.
 *
 * Read in this order: the template's format; an Excel serial (a plain number —
 * what SheetJS hands back for a date-formatted cell); ISO; then day-first with
 * any separator, because the client's sheets are South African.
 */
export function parseDateCell(raw: string, format?: string): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;

  if (format) {
    const m = formatPattern(format)?.exec(v);
    if (m?.groups) return isoDate(fullYear(m.groups.y), Number(m.groups.m), Number(m.groups.d));
  }

  if (/^\d+(\.\d+)?$/.test(v)) {
    const serial = Number(v);
    // 1 is 1900-01-01; the upper bound is Excel's own (9999-12-31).
    if (serial < 1 || serial >= 2958466) return null;
    const d = XLSX.SSF.parse_date_code(serial);
    return d ? isoDate(d.y, d.m, d.d) : null;
  }

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(v);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?:[ T].*)?$/.exec(v);
  if (dmy) return isoDate(fullYear(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  return null;
}

/**
 * A cell's text as a field value. `problem` explains a value that was there
 * but could not be read — never a blank one.
 */
function convertValue(
  raw: string,
  type: FieldValueType,
  mapping: FieldMapping | undefined
): { value: MappedValue; problem?: string } {
  const trimmed = raw.trim();
  switch (type) {
    case "text":
      return { value: trimmed };
    case "reference":
      return { value: isPlaceholderCell(trimmed) ? "" : trimmed };
    case "count": {
      // parseInt, as the trip parser has always read NOP: "3.7" is 3.
      const n = parseInt(raw);
      return { value: n || 0, ...(trimmed && Number.isNaN(n) ? { problem: `"${trimmed}" is not a number` } : {}) };
    }
    case "quantity": {
      const n = parseInt(raw);
      return { value: n || null, ...(trimmed && Number.isNaN(n) ? { problem: `"${trimmed}" is not a number` } : {}) };
    }
    case "date": {
      const value = parseDateCell(trimmed, mapping?.dateFormat);
      return { value, ...(trimmed && !value ? { problem: `"${trimmed}" is not a date` } : {}) };
    }
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────

export interface MappedRow {
  /** 1-based row on the sheet (on a CSV, blank lines are not counted). */
  rowNumber: number;
  values: Record<string, MappedValue>;
}

export interface MappingIssue {
  /** Null for a problem with the sheet as a whole. */
  rowNumber: number | null;
  field: string;
  message: string;
}

export interface MappedSheet {
  /** The header row's cells as written. */
  headers: string[];
  /** Resolved 0-based column per field read from a column. */
  columns: Record<string, number>;
  /** Mapped columns the file does not have. */
  missingColumns: MissingColumn[];
  /** One value per sheet, for header fields. */
  header: Record<string, MappedValue>;
  rows: MappedRow[];
  issues: MappingIssue[];
}

export interface ParseOptions {
  /** Values typed at import, for fields mapped `promptAtImport`. */
  prompts?: Record<string, string>;
  /** The uploaded file's name, for fields mapped `filename`. */
  filename?: string;
}

/**
 * Read a grid through a template.
 *
 * Every column field gets a value on every row — its type's empty value when
 * it is not mapped — so callers never test for absence. Each cell goes:
 * fill down → split → pattern → convert.
 */
export function parseWithTemplate(
  grid: Grid,
  template: SheetTemplate,
  options: ParseOptions = {}
): MappedSheet {
  const fields = fieldsFor(template.sheetType);
  const headers = grid[template.headerRow - 1] ?? [];
  const issues: MappingIssue[] = [];

  const { columns, missingColumns } = resolveColumns(headers, template);

  const patterns = new Map<string, RegExp>();
  for (const field of fields) {
    const source = template.mappings[field.key]?.regex?.trim();
    if (!source) continue;
    const compiled = compileTemplatePattern(source);
    if (compiled.ok) patterns.set(field.key, compiled.pattern);
    else issues.push({ rowNumber: null, field: field.key, message: compiled.error });
  }

  // A field whose pattern was refused reads as blank rather than unfiltered:
  // the pattern exists because the raw cell is not the value.
  const refused = new Set(issues.map((i) => i.field));

  /** `skipPattern`: the raw value has already been through the pattern. */
  const finish = (field: ImportField, raw: string, rowNumber: number | null, skipPattern = false): MappedValue => {
    const mapping = template.mappings[field.key];
    if (refused.has(field.key)) return emptyValue(field.valueType);
    let text = raw;
    const pattern = skipPattern ? undefined : patterns.get(field.key);
    if (pattern && text.trim()) {
      const input = text.trim();
      const matched = matchPattern(pattern, input);
      text = matched ?? "";
      if (matched === null) issues.push({ rowNumber, field: field.key, message: `"${input.slice(0, 60)}" does not match the pattern` });
    }
    const { value, problem } = convertValue(text, field.valueType, mapping);
    if (problem) issues.push({ rowNumber, field: field.key, message: problem });
    return value;
  };

  // Data rows: blank rows are skipped; enough of them in a row end the table.
  const dataRows: { rowNumber: number; cells: string[] }[] = [];
  let blankRun = 0;
  for (let r = Math.max(template.dataStartRow - 1, 0); r < grid.length; r++) {
    if (isBlankRow(grid[r])) {
      blankRun++;
      if (template.stopAtBlankRows > 0 && blankRun >= template.stopAtBlankRows) break;
      continue;
    }
    blankRun = 0;
    dataRows.push({ rowNumber: r + 1, cells: grid[r] });
  }

  // Values that are the same on every row: a fixed cell, a column's first
  // value, or what was typed at import. Header fields live only here.
  const header: Record<string, MappedValue> = {};
  const fixed: Record<string, MappedValue> = {};
  for (const field of fields) {
    const mapping = template.mappings[field.key];
    const asColumn = !mapping || mapping.source === "column";
    if (field.kind === "column" && asColumn) continue;

    let raw = "";
    let patternApplied = false;
    if (mapping?.source === "cell") {
      const at = mapping.cell ? cellAddress(mapping.cell) : null;
      raw = at ? String(grid[at.row]?.[at.col] ?? "") : "";
    } else if (mapping?.source === "promptAtImport") {
      raw = options.prompts?.[field.key] ?? "";
    } else if (mapping?.source === "filename") {
      // The template's own pattern, then the conventions the client's exports
      // (and people renaming them) actually use.
      const stem = filenameStem(options.filename ?? "");
      const pattern = patterns.get(field.key);
      raw = (pattern && stem ? matchPattern(pattern, stem) : null)
        ?? readSheetFilename(options.filename ?? "")?.number
        ?? "";
      patternApplied = true;
      if (!raw && !refused.has(field.key)) {
        issues.push({
          rowNumber: null,
          field: field.key,
          message: stem ? `No sheet number found in the filename "${stem.slice(0, 60)}"` : "No filename to read the sheet number from",
        });
      }
    } else if (mapping) {
      // firstValueInColumn — or `column` on a header field, which can only
      // mean the same thing.
      const index = columns[field.key];
      const first = index === undefined ? undefined : dataRows.find((row) => !isBlankCell(row.cells[index]));
      raw = first && index !== undefined ? String(first.cells[index] ?? "") : "";
    }

    const value = mapping ? finish(field, raw, null, patternApplied) : emptyValue(field.valueType);
    if (field.kind === "header") header[field.key] = value;
    else fixed[field.key] = value;
  }

  // Rows.
  const columnFields = fields.filter((f) => f.kind === "column");
  const splitField = columnFields.find(
    (f) => template.mappings[f.key]?.source === "column" && template.mappings[f.key]?.splitOn?.length
  );
  const carry: Record<string, string> = {};
  const rows: MappedRow[] = [];

  for (const { rowNumber, cells } of dataRows) {
    const rawFor = (field: ImportField): string | undefined => {
      const index = columns[field.key];
      if (index === undefined) return undefined;
      let raw = String(cells[index] ?? "");
      if (template.mappings[field.key]?.fillDown) {
        if (raw.trim() === "") raw = carry[field.key] ?? "";
        else carry[field.key] = raw;
      }
      return raw;
    };

    const values: Record<string, MappedValue> = {};
    let pieces: string[] | null = null;

    for (const field of columnFields) {
      if (field.key in fixed) {
        values[field.key] = fixed[field.key];
        continue;
      }
      const raw = rawFor(field);
      if (raw === undefined) {
        values[field.key] = emptyValue(field.valueType);
        continue;
      }
      if (field === splitField) {
        const separators = template.mappings[field.key].splitOn!.filter(Boolean);
        const split = separators.reduce<string[]>(
          (parts, sep) => parts.flatMap((p) => p.split(sep)),
          [raw]
        );
        const kept = split.map((p) => p.trim()).filter(Boolean);
        pieces = kept.length > 0 ? kept : [raw];
        continue;
      }
      values[field.key] = finish(field, raw, rowNumber);
    }

    if (splitField && pieces) {
      for (const piece of pieces) {
        rows.push({ rowNumber, values: { ...values, [splitField.key]: finish(splitField, piece, rowNumber) } });
      }
    } else {
      rows.push({ rowNumber, values });
    }
  }

  // Values a field must carry.
  for (const field of fields) {
    if (!field.requiresValue) continue;
    if (field.kind === "header") {
      if (isEmptyValue(header[field.key] ?? null)) {
        issues.push({ rowNumber: null, field: field.key, message: `${field.label} is required` });
      }
      continue;
    }
    for (const row of rows) {
      if (isEmptyValue(row.values[field.key])) {
        issues.push({ rowNumber: row.rowNumber, field: field.key, message: `${field.label} is required` });
      }
    }
  }

  return { headers, columns, missingColumns, header, rows, issues };
}

// ─── Template checks ──────────────────────────────────────────────────────

export interface TemplateCheck {
  /** Reasons the template cannot be saved. */
  errors: string[];
  /** Worth a second look, but saveable. */
  warnings: string[];
}

const SOURCES: FieldSource[] = ["column", "cell", "firstValueInColumn", "promptAtImport", "filename"];

/** Whether a template is complete and safe to run. */
export function checkTemplate(template: SheetTemplate): TemplateCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const definition = SHEET_TYPES[template.sheetType];
  if (!definition) return { errors: ["Unknown sheet type."], warnings };

  const byKey = new Map(definition.fields.map((f) => [f.key, f]));
  const isInt = (n: unknown, min: number) => Number.isInteger(n) && (n as number) >= min;

  if (!isInt(template.headerRow, 1)) errors.push("The header row must be 1 or more.");
  if (!isInt(template.dataStartRow, 1) || template.dataStartRow <= template.headerRow) {
    errors.push("Data must start below the header row.");
  }
  if (!isInt(template.stopAtBlankRows, 0)) errors.push("Blank rows to stop at must be 0 or more.");

  const columnUse = new Map<string, string[]>();
  let splitFields = 0;

  for (const [key, mapping] of Object.entries(template.mappings ?? {})) {
    const field = byKey.get(key);
    if (!field) {
      errors.push(`"${key}" is not a ${definition.label.toLowerCase()} field.`);
      continue;
    }
    const label = field.label;
    if (!SOURCES.includes(mapping?.source)) {
      errors.push(`${label}: choose where the value comes from.`);
      continue;
    }

    const readsColumn = mapping.source === "column" || mapping.source === "firstValueInColumn";
    if (readsColumn) {
      const hasHeader = Boolean(mapping.column?.trim());
      const letter = mapping.columnLetter ? columnIndex(mapping.columnLetter) : null;
      if (mapping.columnLetter && letter === null) errors.push(`${label}: "${mapping.columnLetter}" is not a column letter.`);
      if (!hasHeader && letter === null) errors.push(`${label}: choose a column.`);
      const id = hasHeader ? `h:${normalizeHeader(mapping.column!)}` : `l:${letter}`;
      columnUse.set(id, [...(columnUse.get(id) ?? []), label]);
    }
    if (mapping.source === "cell" && !(mapping.cell && cellAddress(mapping.cell))) {
      errors.push(`${label}: choose a cell, e.g. F2.`);
    }
    if (field.kind === "header" && mapping.source === "column") {
      errors.push(`${label} is one value per sheet: choose a cell, the column's first value, or type it at import.`);
    }

    if (mapping.fillDown && mapping.source !== "column") errors.push(`${label}: fill down needs a column.`);
    if (mapping.splitOn?.some(Boolean)) {
      if (mapping.source !== "column") errors.push(`${label}: splitting needs a column.`);
      splitFields++;
    }
    if (mapping.dateFormat) {
      if (field.valueType !== "date") errors.push(`${label} is not a date.`);
      else if (!isValidDateFormat(mapping.dateFormat)) {
        errors.push(`${label}: "${mapping.dateFormat}" needs a day (dd), month (MM) and year (yyyy).`);
      }
    }
    if (mapping.regex?.trim()) {
      const compiled = compileTemplatePattern(mapping.regex);
      if (!compiled.ok) errors.push(`${label}: ${compiled.error}`);
    }
  }

  if (splitFields > 1) errors.push("Only one field can be split into several rows.");

  if (!template.matchAliases) {
    for (const field of definition.fields) {
      if (field.mustMap && !template.mappings?.[field.key]) errors.push(`${field.label} must be mapped.`);
    }
    for (const group of definition.mapAtLeastOne) {
      if (!group.some((key) => template.mappings?.[key])) {
        errors.push(`Map at least one of: ${group.map((k) => byKey.get(k)?.label ?? k).join(", ")}.`);
      }
    }
  }

  for (const labels of columnUse.values()) {
    if (labels.length > 1) warnings.push(`One column is mapped to ${labels.join(" and ")}.`);
  }

  return { errors, warnings };
}
