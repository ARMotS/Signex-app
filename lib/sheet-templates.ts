/**
 * sheet-templates.ts
 * Saved import templates: checking what an ADMIN sends, keeping it in their
 * scope, and choosing which template reads an upload.
 *
 * (lib/import-templates.ts is something else — the blank workbooks offered
 * for download. This file is the saved column mappings.)
 *
 * Choosing, for an upload with no template asked for:
 *   1. a saved template whose header row is exactly this file's
 *      (headerFingerprint) and whose columns are all present — the default
 *      first if several match, then the most recently saved;
 *   2. the scope's default template, if every column it maps is present;
 *   3. the built-in layout, if it can read the file (trip sheets: it finds an
 *      invoice or collection column) — so every sheet that imported before
 *      templates existed still imports, whatever the scope has saved since;
 *   4. the default template's missing columns, if there is a default — it is
 *      the best guess at what the ADMIN meant, and "these columns are
 *      missing" is the message they can act on;
 *   5. otherwise the built-in layout's own error, or NEEDS_TEMPLATE.
 *
 * Asked for by id (the preview's choice, sent back with the deploy), a
 * template is used as long as its columns are present; another scope's id is
 * not found. The deploy re-parse therefore reads the sheet the way the
 * preview did.
 */

import type { ImportTemplate, Prisma } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import { fieldsFor, normalizeHeader, SHEET_TYPES, type ImportSheetType } from "./import-fields";
import {
  aliasColumns,
  BUILT_IN_TRIP_SHEET,
  checkTemplate,
  readGrid,
  resolveColumns,
  type FieldMapping,
  type FieldSource,
  type Grid,
  type MissingColumn,
  type SheetTemplate,
} from "./sheet-mapping";

// ─── Built-in layouts ─────────────────────────────────────────────────────

/** What a deploy sends back to ask for the built-in layout by name. */
export const BUILT_IN_ID = "builtin";

const BUILT_IN: Partial<Record<ImportSheetType, { template: SheetTemplate; name: string }>> = {
  TRIP_SHEET: { template: BUILT_IN_TRIP_SHEET, name: "Built-in trip sheet layout" },
};

export function builtInLayout(sheetType: ImportSheetType) {
  return BUILT_IN[sheetType] ?? null;
}

/** Whether the built-in layout can read this header row at all. */
function builtInReads(sheetType: ImportSheetType, headers: string[]): boolean {
  if (sheetType !== "TRIP_SHEET") return false;
  const columns = aliasColumns(headers, sheetType);
  return "invoiceNumber" in columns || "collectionNo" in columns;
}

// ─── Fingerprints ─────────────────────────────────────────────────────────

/**
 * A header row reduced to what identifies a layout: each cell normalised,
 * trailing blanks dropped (Excel often reports a few empty columns past the
 * table), joined.
 */
export function headerFingerprint(headers: string[]): string {
  const cells = Array.from({ length: headers.length }, (_, i) => normalizeHeader(headers[i] ?? ""));
  while (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells.join("|");
}

// ─── Input ────────────────────────────────────────────────────────────────

export interface TemplateInput {
  sheetType: ImportSheetType;
  name: string;
  isDefault: boolean;
  worksheet: string | null;
  headerRow: number;
  dataStartRow: number;
  stopAtBlankRows: number;
  mappings: Record<string, FieldMapping>;
  /** The sample file's header row, from which the fingerprint is taken. */
  headers: string[];
}

const SOURCES: FieldSource[] = ["column", "cell", "firstValueInColumn", "promptAtImport", "filename"];
const MAX_MAPPINGS = 40;
const MAX_HEADERS = 200;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function boundedString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= max ? s : undefined;
}

function boundedInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * The mappings an ADMIN sent, reduced to the shape the reader understands.
 * Unknown properties are dropped; anything malformed is an error, not a
 * silent omission — a dropped mapping would read as a blank column.
 */
export function readMappings(raw: unknown): { ok: true; mappings: Record<string, FieldMapping> } | { ok: false; error: string } {
  if (!isObject(raw)) return { ok: false, error: "Mappings must be an object." };
  const entries = Object.entries(raw);
  if (entries.length > MAX_MAPPINGS) return { ok: false, error: "Too many mappings." };

  const mappings: Record<string, FieldMapping> = {};
  for (const [key, value] of entries) {
    if (!/^[a-zA-Z]{1,40}$/.test(key)) return { ok: false, error: `"${key.slice(0, 40)}" is not a field.` };
    if (!isObject(value) || !SOURCES.includes(value.source as FieldSource)) {
      return { ok: false, error: `${key}: choose where the value comes from.` };
    }
    const mapping: FieldMapping = { source: value.source as FieldSource };
    const column = boundedString(value.column, 200);
    const columnLetter = boundedString(value.columnLetter, 3);
    const cell = boundedString(value.cell, 10);
    const dateFormat = boundedString(value.dateFormat, 20);
    const regex = boundedString(value.regex, 200);
    if (column) mapping.column = column;
    if (columnLetter) mapping.columnLetter = columnLetter.toUpperCase();
    if (cell) mapping.cell = cell.toUpperCase();
    if (dateFormat) mapping.dateFormat = dateFormat;
    if (regex) mapping.regex = regex;
    if (value.fillDown === true) mapping.fillDown = true;
    if (value.splitOn !== undefined) {
      if (!Array.isArray(value.splitOn) || value.splitOn.length > 5 ||
          !value.splitOn.every((s) => typeof s === "string" && s.length >= 1 && s.length <= 5)) {
        return { ok: false, error: `${key}: separators must be up to five short strings.` };
      }
      if (value.splitOn.length) mapping.splitOn = value.splitOn as string[];
    }
    mappings[key] = mapping;
  }
  return { ok: true, mappings };
}

/** A complete template from a request body, or every reason it is not one. */
export function readTemplateInput(body: unknown): { ok: true; input: TemplateInput } | { ok: false; errors: string[] } {
  if (!isObject(body)) return { ok: false, errors: ["Send the template as JSON."] };
  const errors: string[] = [];

  const sheetType = body.sheetType as ImportSheetType;
  if (!(typeof sheetType === "string" && sheetType in SHEET_TYPES)) errors.push("Choose a sheet type.");

  const name = boundedString(body.name, 80);
  if (!name) errors.push("Give the template a name (up to 80 characters).");

  const worksheet = body.worksheet === null || body.worksheet === undefined || body.worksheet === ""
    ? null
    : boundedString(body.worksheet, 100) ?? undefined;
  if (worksheet === undefined) errors.push("The worksheet name is too long.");

  const headerRow = boundedInt(body.headerRow, 1, 1000);
  const dataStartRow = boundedInt(body.dataStartRow, 1, 1001);
  const stopAtBlankRows = boundedInt(body.stopAtBlankRows ?? 2, 0, 100);
  if (headerRow === null) errors.push("The header row must be a row number.");
  if (dataStartRow === null) errors.push("The first data row must be a row number.");
  if (stopAtBlankRows === null) errors.push("Blank rows to stop at must be 0 to 100.");

  const mappings = readMappings(body.mappings);
  if (!mappings.ok) errors.push(mappings.error);

  const headers = body.headers;
  if (!Array.isArray(headers) || headers.length > MAX_HEADERS ||
      !headers.every((h) => typeof h === "string" && h.length <= 200)) {
    errors.push("Send the sample file's header row.");
  }

  if (errors.length) return { ok: false, errors };

  const input: TemplateInput = {
    sheetType,
    name: name!,
    isDefault: body.isDefault === true,
    worksheet: worksheet ?? null,
    headerRow: headerRow!,
    dataStartRow: dataStartRow!,
    stopAtBlankRows: stopAtBlankRows!,
    mappings: (mappings as { mappings: Record<string, FieldMapping> }).mappings,
    headers: headers as string[],
  };

  const check = checkTemplate(toSheetTemplate(input));
  return check.errors.length ? { ok: false, errors: check.errors } : { ok: true, input };
}

/**
 * A template being drawn up in the wizard: read leniently, because a half
 * finished one must still preview — what is wrong with it is reported by
 * checkTemplate alongside the preview, not by refusing to show one.
 */
export function readDraftTemplate(
  raw: unknown,
  sheetType: ImportSheetType,
  fallback: { headerRow: number; mappings: Record<string, FieldMapping> }
): SheetTemplate {
  const draft = isObject(raw) ? raw : {};
  const headerRow = boundedInt(draft.headerRow, 1, 1000) ?? fallback.headerRow;
  const mappings = "mappings" in draft ? readMappings(draft.mappings) : null;
  return {
    sheetType,
    worksheet: boundedString(draft.worksheet, 100) ?? null,
    headerRow,
    dataStartRow: boundedInt(draft.dataStartRow, 1, 1001) ?? headerRow + 1,
    stopAtBlankRows: boundedInt(draft.stopAtBlankRows, 0, 100) ?? 2,
    mappings: mappings ? (mappings.ok ? mappings.mappings : {}) : fallback.mappings,
  };
}

// ─── Records ──────────────────────────────────────────────────────────────

type TemplateShape = Pick<
  TemplateInput,
  "sheetType" | "worksheet" | "headerRow" | "dataStartRow" | "stopAtBlankRows" | "mappings"
>;

export function toSheetTemplate(t: TemplateShape): SheetTemplate {
  return {
    sheetType: t.sheetType,
    worksheet: t.worksheet,
    headerRow: t.headerRow,
    dataStartRow: t.dataStartRow,
    stopAtBlankRows: t.stopAtBlankRows,
    mappings: t.mappings,
  };
}

/** A stored row as a template, or null if its mappings no longer read. */
export function recordTemplate(row: ImportTemplate): SheetTemplate | null {
  const mappings = readMappings(row.mappings);
  if (!mappings.ok) return null;
  return toSheetTemplate({ ...row, sheetType: row.sheetType as ImportSheetType, mappings: mappings.mappings });
}

/** Values typed at import ({ field: value }), from a request. Bad input reads as none. */
export function readPrompts(raw: unknown): Record<string, string> {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!isObject(value)) return {};
  const prompts: Record<string, string> = {};
  for (const [key, v] of Object.entries(value).slice(0, MAX_MAPPINGS)) {
    if (/^[a-zA-Z]{1,40}$/.test(key) && typeof v === "string") prompts[key] = v.slice(0, 200);
  }
  return prompts;
}

/** A field the template wants typed in at import, as the import screen asks for it. */
export interface TemplatePrompt {
  key: string;
  label: string;
}

export function templatePrompts(template: SheetTemplate): TemplatePrompt[] {
  return fieldsFor(template.sheetType)
    .filter((field) => template.mappings[field.key]?.source === "promptAtImport")
    .map((field) => ({ key: field.key, label: field.label }));
}

/**
 * How a response names the template that read (or was meant to read) a sheet,
 * with the values it wants typed in at import.
 */
export function templateRef(choice: TemplateChosen): { id: string; name: string; prompts: TemplatePrompt[] } {
  return { id: choice.id ?? BUILT_IN_ID, name: choice.name, prompts: templatePrompts(choice.template) };
}

/** What a trip sheet keeps of the template that read it. */
export function templateSnapshot(choice: TemplateChosen): Prisma.InputJsonValue | undefined {
  if (choice.id === null) return undefined;
  return { id: choice.id, name: choice.name, ...choice.template } as unknown as Prisma.InputJsonValue;
}

// ─── Choosing ─────────────────────────────────────────────────────────────

export interface SavedTemplate {
  id: string;
  name: string;
  isDefault: boolean;
  updatedAt: Date;
  fingerprint: string;
  template: SheetTemplate;
}

export interface TemplateChosen {
  ok: true;
  /** null for the built-in layout. */
  id: string | null;
  name: string;
  template: SheetTemplate;
}

export interface TemplateRefused {
  ok: false;
  code: "NEEDS_TEMPLATE" | "MISSING_COLUMNS" | "TEMPLATE_NOT_FOUND";
  error: string;
  missingColumns?: MissingColumn[];
  /** The template that was expected to read the file. */
  template?: { id: string; name: string };
}

export type TemplateChoice = TemplateChosen | TemplateRefused;

/** Default first, then the most recently saved — also the tie-break if two defaults ever exist. */
function byPreference(a: SavedTemplate, b: SavedTemplate): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  return b.updatedAt.getTime() - a.updatedAt.getTime();
}

function missingMessage(name: string, missing: MissingColumn[]): string {
  const list = missing.map((m) => `"${m.column}" (${m.label})`).join(", ");
  return `This sheet does not match the "${name}" import template — it has no ${list} column. ` +
    `Edit the template, or create a new one from this file.`;
}

/**
 * The template to read a file with. Pure: `gridFor` reads the file's
 * worksheet (null = the first), or returns null when it cannot.
 */
export function decideTemplate(
  sheetType: ImportSheetType,
  saved: SavedTemplate[],
  gridFor: (worksheet: string | null) => Grid | null,
  requested?: string | null
): TemplateChoice {
  const builtIn = builtInLayout(sheetType);
  const headersFor = (t: SheetTemplate) => gridFor(t.worksheet)?.[t.headerRow - 1] ?? null;
  const missingFor = (t: SavedTemplate): MissingColumn[] | null => {
    const headers = headersFor(t.template);
    return headers ? resolveColumns(headers, t.template).missingColumns : null;
  };
  const chosen = (t: SavedTemplate): TemplateChosen => ({ ok: true, id: t.id, name: t.name, template: t.template });
  const refusedFor = (t: SavedTemplate, missing: MissingColumn[] | null): TemplateRefused => ({
    ok: false,
    code: "MISSING_COLUMNS",
    error: missing
      ? missingMessage(t.name, missing)
      : `This file has no worksheet called "${t.template.worksheet}", which the "${t.name}" import template reads.`,
    missingColumns: missing ?? [],
    template: { id: t.id, name: t.name },
  });

  if (requested === BUILT_IN_ID) {
    return builtIn
      ? { ok: true, id: null, name: builtIn.name, template: builtIn.template }
      : { ok: false, code: "TEMPLATE_NOT_FOUND", error: "There is no built-in layout for this kind of sheet." };
  }

  if (requested) {
    const t = saved.find((s) => s.id === requested);
    if (!t) return { ok: false, code: "TEMPLATE_NOT_FOUND", error: "Import template not found." };
    const missing = missingFor(t);
    return missing && missing.length === 0 ? chosen(t) : refusedFor(t, missing);
  }

  const ordered = [...saved].sort(byPreference);
  const complete = ordered.filter((t) => missingFor(t)?.length === 0);

  // 1. This exact layout.
  const exact = complete.find((t) => {
    const headers = headersFor(t.template);
    return headers !== null && headerFingerprint(headers) === t.fingerprint;
  });
  if (exact) return chosen(exact);

  // 2. The default, when it can read the file.
  const fallback = ordered.find((t) => t.isDefault);
  if (fallback && complete.includes(fallback)) return chosen(fallback);

  // 3. The built-in layout, when it can read the file.
  if (builtIn && builtInReads(sheetType, gridFor(builtIn.template.worksheet)?.[builtIn.template.headerRow - 1] ?? [])) {
    return { ok: true, id: null, name: builtIn.name, template: builtIn.template };
  }

  // 4. What the default would have needed.
  if (fallback) return refusedFor(fallback, missingFor(fallback));

  // 5. The built-in layout reports its own error; a sheet type without one
  //    needs a template.
  if (builtIn) return { ok: true, id: null, name: builtIn.name, template: builtIn.template };
  return {
    ok: false,
    code: "NEEDS_TEMPLATE",
    error: `Signex does not know this ${SHEET_TYPES[sheetType].label.toLowerCase()} layout yet — set up an import template for it.`,
  };
}

/** This scope's usable templates of one sheet type. */
async function savedTemplates(tenantId: string, sheetType: ImportSheetType): Promise<SavedTemplate[]> {
  const rows = await scopedPrisma(tenantId).importTemplate.findMany({ where: { sheetType } });
  return rows.flatMap((row) => {
    const template = recordTemplate(row);
    return template
      ? [{ id: row.id, name: row.name, isDefault: row.isDefault, updatedAt: row.updatedAt, fingerprint: row.headerFingerprint, template }]
      : [];
  });
}

/** Choose a template for an uploaded file, from this scope's templates only. */
export async function chooseTemplate(
  tenantId: string,
  sheetType: ImportSheetType,
  buffer: Buffer,
  filename: string,
  requested?: string | null
): Promise<TemplateChoice> {
  const saved = requested === BUILT_IN_ID ? [] : await savedTemplates(tenantId, sheetType);
  const grids = new Map<string, Grid | null>();
  const gridFor = (worksheet: string | null): Grid | null => {
    const key = worksheet ?? "";
    if (!grids.has(key)) {
      try {
        const read = readGrid(buffer, filename, worksheet);
        grids.set(key, read.ok ? read.grid : null);
      } catch {
        grids.set(key, null);
      }
    }
    return grids.get(key)!;
  };
  return decideTemplate(sheetType, saved, gridFor, requested);
}

// ─── Storage ──────────────────────────────────────────────────────────────

export interface TemplateSummary {
  id: string;
  sheetType: ImportSheetType;
  name: string;
  isDefault: boolean;
  worksheet: string | null;
  headerRow: number;
  dataStartRow: number;
  stopAtBlankRows: number;
  mappings: Record<string, FieldMapping>;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export function summarize(row: ImportTemplate): TemplateSummary {
  const mappings = readMappings(row.mappings);
  return {
    id: row.id,
    sheetType: row.sheetType as ImportSheetType,
    name: row.name,
    isDefault: row.isDefault,
    worksheet: row.worksheet,
    headerRow: row.headerRow,
    dataStartRow: row.dataStartRow,
    stopAtBlankRows: row.stopAtBlankRows,
    mappings: mappings.ok ? mappings.mappings : {},
    createdByName: row.createdByName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listTemplates(tenantId: string, sheetType?: ImportSheetType): Promise<TemplateSummary[]> {
  const rows = await scopedPrisma(tenantId).importTemplate.findMany({
    where: sheetType ? { sheetType } : {},
    orderBy: [{ sheetType: "asc" }, { isDefault: "desc" }, { name: "asc" }],
  });
  return rows.map(summarize);
}

export async function findTemplate(tenantId: string, id: string): Promise<ImportTemplate | null> {
  return scopedPrisma(tenantId).importTemplate.findFirst({ where: { id } });
}

export class TemplateNameTaken extends Error {
  constructor() {
    super("An import template with that name already exists.");
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/**
 * Save a template (a new one, or over `id`). Becoming the default and
 * clearing the previous default happen in one transaction, so a scope never
 * has two — and never, mid-change, none it did not ask for.
 */
export async function saveTemplate(
  tenantId: string,
  input: TemplateInput,
  by: { id: string; name: string | null },
  id?: string
): Promise<ImportTemplate | null> {
  const db = scopedPrisma(tenantId);
  const data = {
    sheetType: input.sheetType,
    name: input.name,
    isDefault: input.isDefault,
    worksheet: input.worksheet,
    headerRow: input.headerRow,
    dataStartRow: input.dataStartRow,
    stopAtBlankRows: input.stopAtBlankRows,
    headerFingerprint: headerFingerprint(input.headers),
    mappings: input.mappings as unknown as Prisma.InputJsonValue,
  };

  try {
    return await db.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.importTemplate.updateMany({
          where: { sheetType: input.sheetType, isDefault: true, ...(id ? { id: { not: id } } : {}) },
          data: { isDefault: false },
        });
      }
      if (!id) {
        return tx.importTemplate.create({
          data: { ...data, createdById: by.id, createdByName: by.name },
        });
      }
      const updated = await tx.importTemplate.updateMany({ where: { id }, data });
      return updated.count === 1 ? tx.importTemplate.findFirst({ where: { id } }) : null;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new TemplateNameTaken();
    throw err;
  }
}

/** True when the template existed in this scope and is gone. */
export async function deleteTemplate(tenantId: string, id: string): Promise<boolean> {
  const deleted = await scopedPrisma(tenantId).importTemplate.deleteMany({ where: { id } });
  return deleted.count === 1;
}
