import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { SHEET_TYPES, type ImportSheetType } from "@/lib/import-fields";
import {
  checkTemplate,
  detectHeaderRow,
  parseWithTemplate,
  readGrid,
  suggestMappings,
  type SheetTemplate,
} from "@/lib/sheet-mapping";
import {
  findTemplate,
  readDraftTemplate,
  readPrompts,
  recordTemplate,
  templatePrompts,
} from "@/lib/sheet-templates";
import { parseTripSheet } from "@/lib/trip-parser";

/** Parsing lists the invoice folder for a trip sheet — see ../../trip-sheet/route.ts. */
export const maxDuration = 60;

const MAX_BYTES = 10 * 1024 * 1024;
const GRID_ROWS = 20;
const GRID_COLS = 40;
const RESULT_ROWS = 200;
const ISSUES = 500;

/**
 * Read a sample file through a draft template, for the mapping wizard.
 *
 * multipart: file, sheetType, and either `template` (JSON — the draft as it
 * stands; omitted, the detected header row and suggested columns are used) or
 * `templateId` (a saved template of this scope). Nothing is saved.
 *
 * A trip sheet that maps cleanly is also run through the real parser, so the
 * preview shows what a deploy would: drivers matched, invoices with no PDF.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const form = await request.formData();
  const file = form.get("file") as File | null;
  const sheetType = form.get("sheetType") as ImportSheetType | null;

  if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large. Maximum size is 10MB." }, { status: 400 });
  }
  if (!sheetType || !(sheetType in SHEET_TYPES)) {
    return NextResponse.json({ error: "Choose a sheet type." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let saved: SheetTemplate | null = null;
  const templateId = form.get("templateId") as string | null;
  if (templateId) {
    const row = await findTemplate(ctx.tenantId, templateId);
    saved = row && row.sheetType === sheetType ? recordTemplate(row) : null;
    if (!saved) return NextResponse.json({ error: "Import template not found" }, { status: 404 });
  }

  let draft: unknown = null;
  const rawDraft = form.get("template");
  if (typeof rawDraft === "string" && rawDraft) {
    try {
      draft = JSON.parse(rawDraft);
    } catch {
      return NextResponse.json({ error: "The template is not valid JSON." }, { status: 400 });
    }
  }
  const worksheet =
    saved?.worksheet ??
    (draft && typeof draft === "object" && typeof (draft as { worksheet?: unknown }).worksheet === "string"
      ? (draft as { worksheet: string }).worksheet
      : null);

  let read;
  try {
    read = readGrid(buffer, file.name, worksheet);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    );
  }
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });

  const detectedHeaderRow = detectHeaderRow(read.grid, sheetType);
  const template =
    saved ??
    readDraftTemplate(draft, sheetType, {
      headerRow: detectedHeaderRow,
      mappings: suggestMappings(read.grid[detectedHeaderRow - 1] ?? [], sheetType),
    });
  const headers = read.grid[template.headerRow - 1] ?? [];
  const prompts = readPrompts(form.get("prompts"));
  const check = checkTemplate(template);
  const mapped = parseWithTemplate(read.grid, template, { prompts, filename: file.name });

  let trip = null;
  if (sheetType === "TRIP_SHEET" && check.errors.length === 0 && mapped.missingColumns.length === 0) {
    const parsed = await parseTripSheet(ctx.tenantId, buffer, file.name, { template, prompts });
    trip = parsed.success
      ? {
          totalRows: parsed.totalRows,
          matchedInvoices: parsed.matchedInvoices,
          unmatchedInvoices: parsed.unmatchedInvoices,
          missingInvoices: parsed.missingInvoices,
          alreadySigned: parsed.alreadySigned.length,
          totalCollections: parsed.totalCollections,
          drivers: parsed.driverResults.map((d) => ({
            driverId: d.driverId,
            driverName: d.driverName,
            stops: d.stops.length,
          })),
        }
      : { error: parsed.error };
  }

  const clip = (cell: unknown) => String(cell ?? "").slice(0, 100);
  return NextResponse.json({
    sheetNames: read.sheetNames,
    worksheet: read.worksheet,
    rowCount: read.grid.length,
    grid: read.grid.slice(0, Math.max(GRID_ROWS, template.dataStartRow + 5)).map((row) =>
      Array.from({ length: Math.min(row.length, GRID_COLS) }, (_, i) => clip(row[i]))
    ),
    detectedHeaderRow,
    // Unclipped (within what a template accepts): saving takes the
    // fingerprint from this, and a shortened header would never match again.
    headers: Array.from({ length: Math.min(headers.length, 200) }, (_, i) => String(headers[i] ?? "").slice(0, 200)),
    prompts: templatePrompts(template),
    suggestions: suggestMappings(headers, sheetType),
    template,
    check,
    result: {
      columns: mapped.columns,
      missingColumns: mapped.missingColumns,
      header: mapped.header,
      rowCount: mapped.rows.length,
      rows: mapped.rows.slice(0, RESULT_ROWS),
      issues: mapped.issues.slice(0, ISSUES),
      issueCount: mapped.issues.length,
    },
    trip,
  });
});
