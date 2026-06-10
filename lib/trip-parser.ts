/**
 * Trip sheet parser — handles CSV and Excel files.
 * Auto-detects columns and matches invoice numbers to PDF files + driver accounts.
 *
 * Expected columns (auto-detected by header):
 *   1. Date       — trip date for reference
 *   2. Driver     — driver name (used for matching as fallback)
 *   3. REGNO      — vehicle registration (used for matching as priority)
 *   4. Customer   — customer name (displayed on driver app)
 *   5. INVOICENO  — invoice number (matched to PDF files)
 *   6. NOP        — number of parcels (displayed on driver app)
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";
import crypto from "crypto";
import { listInvoiceFiles } from "./invoices";
import { listDrivers } from "./accounts";
import { prisma } from "./db";
import type { TripStop } from "./trip-data";

// ─── Types ────────────────────────────────────────────────────────────────

export interface ParsedRow {
  date: string;
  driverName: string;
  regNo: string;
  customerName: string;
  invoiceNumber: string;
  nop: number;
}

export interface MatchResult {
  driverId: string;
  driverName: string;
  regNo: string;
  stops: TripStop[];
  unmatchedInvoices: string[]; // invoice numbers with no PDF found
}

export interface AlreadySignedInvoice {
  invoiceNumber: string;
  signedAt: string | null;
  driverName: string | null;
  source: "database" | "filesystem";
}

export interface ParseResult {
  success: boolean;
  error?: string;
  rows: ParsedRow[];
  driverResults: MatchResult[];
  totalRows: number;
  matchedInvoices: number;
  unmatchedInvoices: number;
  alreadySigned: AlreadySignedInvoice[];
}

// ─── Column Detection ─────────────────────────────────────────────────────

const COLUMN_PATTERNS: Record<string, RegExp[]> = {
  date: [
    /^date$/i,
    /^trip\s*date$/i,
    /^delivery\s*date$/i,
    /^del\.\s*date$/i,
  ],
  driverName: [
    /^driver\s*name$/i,
    /^driver$/i,
    /^assigned\s*to$/i,
    /^assigned$/i,
  ],
  regNo: [
    /^regno$/i,
    /^reg\s*no\.?$/i,
    /^reg$/i,
    /^registration$/i,
    /^vehicle\s*reg/i,
    /^vehicle$/i,
    /^reg\s*num/i,
    /^plate/i,
    /^number\s*plate/i,
  ],
  customerName: [
    /^customer\s*name$/i,
    /^customer$/i,
    /^client\s*name$/i,
    /^client$/i,
    /^name$/i,
    /^company$/i,
    /^deliver\s*to$/i,
  ],
  invoiceNumber: [
    /^invoiceno$/i,
    /^invoice\s*no\.?$/i,
    /^invoice\s*#?\s*n/i,
    /^invoice\s*#/i,
    /^invoice\s*num/i,
    /^inv\s*#/i,
    /^inv\.?\s*no/i,
    /^invoice$/i,
    /^inv$/i,
  ],
  nop: [
    /^nop$/i,
    /^n\.?o\.?p\.?$/i,
    /^num\s*(of\s*)?parcels$/i,
    /^number\s*of\s*parcels$/i,
    /^parcels$/i,
    /^qty$/i,
    /^quantity$/i,
    /^pcs$/i,
    /^pieces$/i,
  ],
};

function detectColumn(header: string): string | null {
  const trimmed = header.trim();
  if (!trimmed) return null;

  for (const [field, patterns] of Object.entries(COLUMN_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        return field;
      }
    }
  }
  return null;
}

function mapColumns(headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  headers.forEach((header, index) => {
    if (!header) return; // skip null/empty headers
    const field = detectColumn(header);
    if (field && !(field in mapping)) {
      mapping[field] = index;
    }
  });
  return mapping;
}

// ─── Invoice Number Normalization ─────────────────────────────────────────

/**
 * Normalize an invoice number for matching.
 * Handles formats: "Invoice # 001", "INV-001", "Invoice 001", "001", "827323", etc.
 * For "IV-365-4.pdf" style filenames, extracts the middle numeric value (365).
 * Strips prefixes, spaces, hyphens. Leading zeros are preserved.
 */
function normalizeInvoiceNumber(raw: string): string {
  let normalized = String(raw).trim().toUpperCase();

  // Strip .pdf extension if present
  normalized = normalized.replace(/\.PDF$/i, "");

  // Handle IV-NNN-N format: extract the middle number only
  const ivMatch = normalized.match(/^IV[- ](\d+)[- ]\d+$/i);
  if (ivMatch) {
    return ivMatch[1];
  }

  // Remove common prefixes: "INVOICE #", "INVOICE#", "INV-", "INV ", "INVOICE "
  normalized = normalized
    .replace(/^INVOICE\s*#\s*/i, "")
    .replace(/^INVOICE\s+/i, "")
    .replace(/^INV[\s\-\.#]*/i, "");

  // Remove remaining spaces and hyphens for comparison
  normalized = normalized.replace(/[\s\-]/g, "");

  return normalized;
}

// ─── File Parsing ─────────────────────────────────────────────────────────

function parseCSVContent(content: string): string[][] {
  const result = Papa.parse<string[]>(content, {
    skipEmptyLines: true,
  });
  return result.data;
}

function parseExcelContent(buffer: Buffer): string[][] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
  // Convert all values to strings
  return data.map((row) => row.map((cell) => String(cell ?? "")));
}

// ─── Main Parse Function ──────────────────────────────────────────────────

export async function parseTripSheet(
  fileBuffer: Buffer,
  filename: string
): Promise<ParseResult> {
  try {
    // 1. Parse the file into rows
    const ext = filename.toLowerCase().split(".").pop();
    let rawRows: string[][];

    if (ext === "csv") {
      rawRows = parseCSVContent(fileBuffer.toString("utf-8"));
    } else if (ext === "xlsx" || ext === "xls") {
      rawRows = parseExcelContent(fileBuffer);
    } else {
      return {
        success: false,
        error: `Unsupported file type: .${ext}. Use CSV or Excel (.xlsx/.xls)`,
        rows: [],
        driverResults: [],
        totalRows: 0,
        matchedInvoices: 0,
        unmatchedInvoices: 0,
        alreadySigned: [],
      };
    }

    if (rawRows.length < 2) {
      return {
        success: false,
        error: "File has no data rows (needs a header row + at least one data row)",
        rows: [],
        driverResults: [],
        totalRows: 0,
        matchedInvoices: 0,
        unmatchedInvoices: 0,
        alreadySigned: [],
      };
    }

    // 2. Detect columns from header row
    const headers = rawRows[0];
    const columnMap = mapColumns(headers);

    if (!columnMap.invoiceNumber) {
      return {
        success: false,
        error: `Could not detect an invoice number column. Headers found: ${headers.filter(Boolean).join(", ")}`,
        rows: [],
        driverResults: [],
        totalRows: 0,
        matchedInvoices: 0,
        unmatchedInvoices: 0,
        alreadySigned: [],
      };
    }

    // 3. Parse data rows
    const dataRows = rawRows.slice(1).filter((row) =>
      row.some((cell) => cell && cell.trim() !== "")
    );

    const parsedRows: ParsedRow[] = dataRows
      .map((row) => ({
        date: columnMap.date !== undefined
          ? row[columnMap.date]?.trim() || ""
          : "",
        driverName: columnMap.driverName !== undefined
          ? row[columnMap.driverName]?.trim() || ""
          : "",
        regNo: columnMap.regNo !== undefined
          ? row[columnMap.regNo]?.trim() || ""
          : "",
        customerName: columnMap.customerName !== undefined
          ? row[columnMap.customerName]?.trim() || ""
          : "",
        invoiceNumber: String(row[columnMap.invoiceNumber] ?? "").trim(),
        nop: columnMap.nop !== undefined
          ? parseInt(row[columnMap.nop]) || 0
          : 0,
      }))
      .filter((row) => row.invoiceNumber !== "");

    // 4. Get existing invoices and drivers for matching
    const invoiceFiles = await listInvoiceFiles();
    const drivers = await listDrivers();

    // Build invoice lookup: normalized number → filename
    const invoiceLookup = new Map<string, string>();
    for (const inv of invoiceFiles) {
      const normalized = normalizeInvoiceNumber(inv.invoiceNumber);
      invoiceLookup.set(normalized, inv.filename);
      // Also try just the numeric part
      const numericOnly = normalized.replace(/\D/g, "");
      if (numericOnly) {
        invoiceLookup.set(numericOnly, inv.filename);
      }
    }

    // Build driver lookup by name
    const driverByName = new Map<string, { id: string; name: string }>();

    for (const d of drivers) {
      driverByName.set(d.name.toLowerCase(), { id: d.id, name: d.name });
    }

    // 5. Group rows by driver and match invoices
    //    Match by driver name; regNo from the sheet is carried as trip metadata
    const driverGroupMap = new Map<string, {
      driver: { id: string; name: string };
      rows: ParsedRow[];
    }>();
    const unassignedRows: ParsedRow[] = [];

    for (const row of parsedRows) {
      let driverInfo: { id: string; name: string } | undefined;

      if (row.driverName) {
        driverInfo = driverByName.get(row.driverName.toLowerCase());
      }

      if (driverInfo) {
        const existing = driverGroupMap.get(driverInfo.id);
        if (existing) {
          existing.rows.push(row);
        } else {
          driverGroupMap.set(driverInfo.id, { driver: driverInfo, rows: [row] });
        }
      } else {
        unassignedRows.push(row);
      }
    }

    // 6. Build match results per driver
    let totalMatched = 0;
    let totalUnmatched = 0;

    const driverResults: MatchResult[] = [];

    for (const [, group] of driverGroupMap) {
      const stops: TripStop[] = [];
      const unmatchedInvoices: string[] = [];

      group.rows.forEach((row, idx) => {
        const normalizedInv = normalizeInvoiceNumber(row.invoiceNumber);
        const numericOnly = normalizedInv.replace(/\D/g, "");
        const matchedFile = invoiceLookup.get(normalizedInv) || invoiceLookup.get(numericOnly);

        if (matchedFile) {
          totalMatched++;
        } else {
          totalUnmatched++;
          unmatchedInvoices.push(row.invoiceNumber);
        }

        stops.push({
          id: crypto.randomUUID(),
          stopNumber: idx + 1,
          invoiceNumber: row.invoiceNumber,
          customerName: row.customerName || "Unknown",
          address: "",
          nop: row.nop,
          invoiceFile: matchedFile,
          status: "PENDING",
        });
      });

      driverResults.push({
        driverId: group.driver.id,
        driverName: group.driver.name,
        regNo: group.rows[0]?.regNo || "",
        stops,
        unmatchedInvoices,
      });
    }

    // Handle unassigned rows (no driver found)
    if (unassignedRows.length > 0) {
      const stops: TripStop[] = [];
      const unmatchedInvoices: string[] = [];

      unassignedRows.forEach((row, idx) => {
        const normalizedInv = normalizeInvoiceNumber(row.invoiceNumber);
        const numericOnly = normalizedInv.replace(/\D/g, "");
        const matchedFile = invoiceLookup.get(normalizedInv) || invoiceLookup.get(numericOnly);

        if (matchedFile) {
          totalMatched++;
        } else {
          totalUnmatched++;
          unmatchedInvoices.push(row.invoiceNumber);
        }

        stops.push({
          id: crypto.randomUUID(),
          stopNumber: idx + 1,
          invoiceNumber: row.invoiceNumber,
          customerName: row.customerName || "Unknown",
          address: "",
          nop: row.nop,
          invoiceFile: matchedFile,
          status: "PENDING",
        });
      });

      driverResults.push({
        driverId: "__unassigned__",
        driverName: unassignedRows[0]?.driverName || "Unassigned",
        regNo: unassignedRows[0]?.regNo || "",
        stops,
        unmatchedInvoices,
      });
    }

    // 7. Detect invoices that were already signed (DB or filesystem)
    const allInvoiceNumbers = parsedRows.map((r) => r.invoiceNumber).filter(Boolean);
    const alreadySigned = await detectAlreadySignedInvoices(allInvoiceNumbers, invoiceFiles);

    return {
      success: true,
      rows: parsedRows,
      driverResults,
      totalRows: parsedRows.length,
      matchedInvoices: totalMatched,
      unmatchedInvoices: totalUnmatched,
      alreadySigned,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`,
      rows: [],
      driverResults: [],
      totalRows: 0,
      matchedInvoices: 0,
      unmatchedInvoices: 0,
      alreadySigned: [],
    };
  }
}

// ─── Already-Signed Invoice Detection ────────────────────────────────────

/**
 * Check if any invoice numbers in the trip sheet have already been signed.
 * Checks two sources:
 *   1. Database: stops with status=SIGNED matching these invoice numbers
 *   2. Filesystem: files in the signed/ subfolder of the invoice folder
 */
async function detectAlreadySignedInvoices(
  invoiceNumbers: string[],
  invoiceFiles: { filename: string; invoiceNumber: string; isSigned: boolean; signedAt?: string }[]
): Promise<AlreadySignedInvoice[]> {
  if (invoiceNumbers.length === 0) return [];

  const results: AlreadySignedInvoice[] = [];
  const seen = new Set<string>();

  // Source 1: Check database for stops already signed with these invoice numbers
  const signedStops = await prisma.stop.findMany({
    where: {
      invoiceNumber: { in: invoiceNumbers },
      status: "SIGNED",
    },
    select: {
      invoiceNumber: true,
      signedAt: true,
      tripSheet: {
        select: {
          driver: { select: { name: true } },
        },
      },
    },
  });

  for (const stop of signedStops) {
    const key = stop.invoiceNumber.toUpperCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push({
        invoiceNumber: stop.invoiceNumber,
        signedAt: stop.signedAt?.toISOString() || null,
        driverName: stop.tripSheet?.driver?.name || null,
        source: "database",
      });
    }
  }

  // Source 2: Check filesystem signed/ folder
  const normalizedInput = new Map(
    invoiceNumbers.map((inv) => [normalizeInvoiceNumber(inv), inv])
  );

  for (const file of invoiceFiles) {
    if (!file.isSigned) continue;
    const normalized = normalizeInvoiceNumber(file.invoiceNumber);
    const originalInv = normalizedInput.get(normalized);
    if (originalInv && !seen.has(originalInv.toUpperCase())) {
      seen.add(originalInv.toUpperCase());
      results.push({
        invoiceNumber: originalInv,
        signedAt: file.signedAt || null,
        driverName: null,
        source: "filesystem",
      });
    }
  }

  return results;
}
