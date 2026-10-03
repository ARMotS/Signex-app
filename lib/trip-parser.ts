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
 *   6. COLLECTNO  — collection number (matched to collection documents)
 *   7. NOP        — number of parcels (displayed on driver app)
 *
 * A row may carry an invoice, a collection, or both. Sheets written before
 * collections existed have no COLLECTNO column at all and parse unchanged —
 * the column is detected, never required.
 */

import Papa from "papaparse";
import * as XLSX from "xlsx";
import crypto from "crypto";
import { listInvoiceFiles } from "./invoices";
import {
  buildCollectionLookup,
  listCollectionFolder,
  matchCollectionDocument,
} from "./collections";
import { listDrivers } from "./accounts";
import { scopedPrisma } from "./db-scoped";
import type { TripCollection, TripStop } from "./trip-data";

// ─── Types ────────────────────────────────────────────────────────────────

export interface ParsedRow {
  date: string;
  driverName: string;
  regNo: string;
  customerName: string;
  invoiceNumber: string;
  /** COLLECTNO. Empty when the row is a plain delivery. */
  collectionNo: string;
  /** Raw COLLECTTYPE cell, if the sheet carries one. Interpreted below. */
  collectionType: string;
  /** Explicit ORIGINALINVOICENO column, if present. */
  originalInvoiceNo: string;
  /** COLLECTQTY — how many units the office expects back. */
  collectQty: number | null;
  nop: number;
}

export interface MatchResult {
  driverId: string;
  driverName: string;
  regNo: string;
  stops: TripStop[];
  unmatchedInvoices: string[]; // invoice numbers with no PDF found
  /** Collection numbers with no document in Collections/Pending */
  unmatchedCollections: string[];
}

export interface AlreadySignedInvoice {
  invoiceNumber: string;
  signedAt: string | null;
  driverName: string | null;
  source: "database" | "filesystem";
}

/**
 * A row on the sheet whose invoice PDF is not in the invoice folder.
 *
 * Reported flat, alongside the per-driver `unmatchedInvoices`, because the
 * dispatcher resolves these one at a time — upload the PDF or drop the stop —
 * and needs to see which customer and driver each one belongs to without
 * walking the driver groups.
 */
export interface MissingInvoice {
  invoiceNumber: string;
  customerName: string;
  driverName: string;
  /** The preview stop this row became, so the UI can key off it */
  stopId: string;
}

export interface ParseResult {
  success: boolean;
  error?: string;
  rows: ParsedRow[];
  driverResults: MatchResult[];
  totalRows: number;
  matchedInvoices: number;
  unmatchedInvoices: number;
  /** Collections found on the sheet, across all drivers */
  totalCollections: number;
  /** Collections whose document was found in Collections/Pending */
  matchedCollections: number;
  /**
   * Collections with no document yet.
   *
   * Reported, never fatal. A missing INVOICE blocks a deploy because the
   * signature is embedded on the invoice and a delivery without one leaves no
   * physical record; a collection with no document is simply a collection the
   * office has not papered yet, and the driver can still collect the goods and
   * sign for them on a generated receipt.
   */
  unmatchedCollections: number;
  /**
   * Set when the collections folder could not be read. Without it, an
   * unreadable folder made every collection read as "no document yet" — the
   * dispatcher saw a papering gap where there was really a configuration one.
   */
  collectionsFolderError?: string;
  alreadySigned: AlreadySignedInvoice[];
  /** Every row with no matching PDF, across all drivers */
  missingInvoices: MissingInvoice[];
}

/** An empty result, so the early returns below stay one line each. */
function emptyResult(error?: string): ParseResult {
  return {
    success: !error,
    ...(error ? { error } : {}),
    rows: [],
    driverResults: [],
    totalRows: 0,
    matchedInvoices: 0,
    unmatchedInvoices: 0,
    totalCollections: 0,
    matchedCollections: 0,
    unmatchedCollections: 0,
    alreadySigned: [],
    missingInvoices: [],
  };
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
  // Tolerant on purpose: the same column is written COLLECTNO, "Collection No",
  // "Coll No" and "Collect #" by different depots, and a header that fails to
  // match silently drops every collection on the sheet.
  collectionNo: [
    /^collectno$/i,
    /^collection\s*no\.?$/i,
    /^collect\s*no\.?$/i,
    /^coll\s*no\.?$/i,
    /^collection\s*#/i,
    /^collect\s*#/i,
    /^coll\s*#/i,
    /^collection\s*num/i,
    /^collection$/i,
    /^collect$/i,
  ],
  collectionType: [
    /^collecttype$/i,
    /^collection\s*type$/i,
    /^collect\s*type$/i,
    /^coll\s*type$/i,
    /^uplift\s*type$/i,
  ],
  originalInvoiceNo: [
    /^originalinvoiceno$/i,
    /^original\s*invoice\s*no\.?$/i,
    /^original\s*invoice$/i,
    /^orig\s*inv(oice)?\s*no\.?$/i,
    /^credit\s*against$/i,
    /^against\s*invoice$/i,
  ],
  collectQty: [
    /^collectqty$/i,
    /^collect\s*qty$/i,
    /^collection\s*qty$/i,
    /^coll\s*qty$/i,
    /^expected\s*qty$/i,
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

/** Exported for tests: the template headers must land on the right fields. */
export function detectColumn(header: string): string | null {
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
export function normalizeInvoiceNumber(raw: string): string {
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

// ─── Collection Type ──────────────────────────────────────────────────────

export interface CollectionTyping {
  type: TripCollection["type"];
  upliftSubtype: TripCollection["upliftSubtype"];
}

/**
 * Read a COLLECTTYPE cell into a type and, where it says so, a subtype.
 *
 * The sheet only has to carry COLLECTNO — the type column is optional, and an
 * empty or unrecognised cell means CREDIT_RETURN. That is the right default
 * because a credit return is the case that reconciles against an invoice, and
 * it is the only one that can be inferred from the sheet at all: a row carrying
 * both an invoice and a collection is a return against that invoice. An ADMIN
 * can change the type on the trip view, and the driver sees it before they
 * collect.
 *
 * A bare "uplift" with no subtype becomes COMPANY_PARCEL, the most generic
 * non-creditable item — NON_CREDIT_UPLIFT without a subtype would fail
 * validateCollectionType and reject the whole sheet over a vague cell.
 */
export function parseCollectionTyping(raw: string): CollectionTyping {
  const v = String(raw ?? "").trim().toLowerCase();

  if (!v) return { type: "CREDIT_RETURN", upliftSubtype: null };

  if (/parcel/.test(v)) {
    return { type: "NON_CREDIT_UPLIFT", upliftSubtype: "COMPANY_PARCEL" };
  }
  if (/equip|crate|pallet|cage/.test(v)) {
    return { type: "NON_CREDIT_UPLIFT", upliftSubtype: "EQUIPMENT_OR_CRATES" };
  }
  if (/doc|paperwork|pod/.test(v)) {
    return { type: "NON_CREDIT_UPLIFT", upliftSubtype: "DOCUMENTS" };
  }
  if (/special|request|adhoc|ad hoc/.test(v)) {
    return { type: "NON_CREDIT_UPLIFT", upliftSubtype: "SPECIAL_REQUEST" };
  }
  if (/uplift|non[\s-]?credit|nc/.test(v)) {
    return { type: "NON_CREDIT_UPLIFT", upliftSubtype: "COMPANY_PARCEL" };
  }

  return { type: "CREDIT_RETURN", upliftSubtype: null };
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

/**
 * Parse a trip sheet within ONE scope.
 *
 * The matching rules are unchanged — drivers are matched by name and the sheet's
 * regNo is carried through as trip metadata. What changed is the candidate pool:
 * driver names, invoice files and already-signed history all come from
 * `tenantId` only, so an ADMIN's upload can never bind to another ADMIN's driver
 * or reveal that another ADMIN already signed the same invoice number.
 */
export async function parseTripSheet(
  tenantId: string,
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
      return emptyResult(
        `Unsupported file type: .${ext}. Use CSV or Excel (.xlsx/.xls)`
      );
    }

    if (rawRows.length < 2) {
      return emptyResult(
        "File has no data rows (needs a header row + at least one data row)"
      );
    }

    // 2. Detect columns from header row
    const headers = rawRows[0];
    const columnMap = mapColumns(headers);

    // A sheet needs one or the other, not both: a run can legitimately be
    // nothing but collections. Compared against undefined rather than tested for
    // truthiness because column index 0 is a real column — INVOICENO in the
    // first column used to be reported as "no invoice column found".
    if (columnMap.invoiceNumber === undefined && columnMap.collectionNo === undefined) {
      return emptyResult(
        `Could not detect an invoice number or collection number column. Headers found: ${headers.filter(Boolean).join(", ")}`
      );
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
        invoiceNumber: columnMap.invoiceNumber !== undefined
          ? String(row[columnMap.invoiceNumber] ?? "").trim()
          : "",
        collectionNo: columnMap.collectionNo !== undefined
          ? String(row[columnMap.collectionNo] ?? "").trim()
          : "",
        collectionType: columnMap.collectionType !== undefined
          ? String(row[columnMap.collectionType] ?? "").trim()
          : "",
        originalInvoiceNo: columnMap.originalInvoiceNo !== undefined
          ? String(row[columnMap.originalInvoiceNo] ?? "").trim()
          : "",
        collectQty: columnMap.collectQty !== undefined
          ? parseInt(row[columnMap.collectQty]) || null
          : null,
        nop: columnMap.nop !== undefined
          ? parseInt(row[columnMap.nop]) || 0
          : 0,
      }))
      // A row has to carry something. Before collections, a blank invoice cell
      // could only mean a blank row; now it can mean a collection-only visit.
      .filter((row) => row.invoiceNumber !== "" || row.collectionNo !== "");

    // 4. Get this scope's existing invoices, collection documents and drivers.
    //    All three are scoped, and the two folder listings go over Graph, so
    //    they are fetched together rather than one after the other.
    const [invoiceFiles, collectionFolder, drivers] = await Promise.all([
      listInvoiceFiles(tenantId),
      listCollectionFolder(tenantId),
      listDrivers(tenantId),
    ]);

    const collectionLookup = buildCollectionLookup(collectionFolder.documents);

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
    let totalCollections = 0;
    let matchedCollections = 0;
    let unmatchedCollectionCount = 0;

    const driverResults: MatchResult[] = [];
    const missingInvoices: MissingInvoice[] = [];

    /**
     * Turn one driver's rows into stops.
     *
     * Invoice rows become stops exactly as they always have — one row, one
     * stop, in sheet order. What is new is where a COLLECTNO goes:
     *
     *   • invoice + collection on one row → the collection joins that stop;
     *   • collection only, customer has an invoice row anywhere in this group
     *     → it joins that customer's stop, even if the invoice row is further
     *     down the sheet;
     *   • collection only, customer has no invoice row → its own stop, with a
     *     blank invoice number.
     *
     * The driver therefore sees one visit per customer address carrying both
     * lists, rather than a delivery and a collection listed as unrelated jobs
     * at the same place. Invoice rows are never merged with each other: two
     * invoices for one customer are still two stops, as before.
     *
     * @param labelFor Which driver name to record against a missing invoice.
     *                 Per row, because the unassigned group is a mix.
     */
    const buildStops = (
      rows: ParsedRow[],
      labelFor: (row: ParsedRow) => string
    ): Pick<MatchResult, "stops" | "unmatchedInvoices" | "unmatchedCollections"> => {
      const stops: TripStop[] = [];
      const unmatchedInvoices: string[] = [];
      const unmatchedCollections: string[] = [];

      const customerKey = (row: ParsedRow) => row.customerName.trim().toLowerCase();

      // Customers with at least one invoice row somewhere in this group. An
      // unnamed customer is never grouped — every "Unknown" would otherwise
      // collapse into a single stop.
      const invoiceCustomers = new Set(
        rows.filter((r) => r.invoiceNumber && customerKey(r)).map(customerKey)
      );

      const stopByCustomer = new Map<string, TripStop>();
      const deferred = new Map<string, ParsedRow[]>();

      const attach = (row: ParsedRow, stop: TripStop) => {
        const doc = matchCollectionDocument(collectionLookup, row.collectionNo);
        const typing = parseCollectionTyping(row.collectionType);

        totalCollections++;
        if (doc) {
          matchedCollections++;
        } else {
          unmatchedCollectionCount++;
          unmatchedCollections.push(row.collectionNo);
        }

        stop.collections = stop.collections || [];
        stop.collections.push({
          id: crypto.randomUUID(),
          collectionNo: row.collectionNo,
          type: typing.type,
          upliftSubtype: typing.upliftSubtype,
          notes: null,
          // A credit return sharing a row with an invoice credits that invoice,
          // unless the sheet names a different one outright.
          originalInvoiceNo:
            row.originalInvoiceNo ||
            (typing.type === "CREDIT_RETURN" ? stop.invoiceNumber || null : null),
          status: "PENDING",
          exceptionReason: null,
          expectedQty: row.collectQty,
          collectedQty: null,
          sourceFileId: doc?.itemId ?? null,
          sourceFilePath: doc?.filename ?? null,
        });
      };

      const makeStop = (row: ParsedRow): TripStop => {
        const stopId = crypto.randomUUID();
        let matchedFile: string | undefined;

        if (row.invoiceNumber) {
          const normalizedInv = normalizeInvoiceNumber(row.invoiceNumber);
          const numericOnly = normalizedInv.replace(/\D/g, "");
          matchedFile =
            invoiceLookup.get(normalizedInv) || invoiceLookup.get(numericOnly);

          if (matchedFile) {
            totalMatched++;
          } else {
            totalUnmatched++;
            unmatchedInvoices.push(row.invoiceNumber);
            missingInvoices.push({
              invoiceNumber: row.invoiceNumber,
              customerName: row.customerName || "Unknown",
              driverName: labelFor(row),
              stopId,
            });
          }
        }

        const stop: TripStop = {
          id: stopId,
          // Renumbered once the whole group is built, so a deferred
          // collection-only row cannot leave a gap in the sequence.
          stopNumber: 0,
          invoiceNumber: row.invoiceNumber,
          customerName: row.customerName || "Unknown",
          address: "",
          nop: row.nop,
          invoiceFile: matchedFile,
          status: "PENDING",
          collections: [],
        };

        stops.push(stop);
        return stop;
      };

      for (const row of rows) {
        const key = customerKey(row);

        if (row.invoiceNumber) {
          const stop = makeStop(row);
          if (key && !stopByCustomer.has(key)) {
            stopByCustomer.set(key, stop);
            for (const waiting of deferred.get(key) ?? []) attach(waiting, stop);
            deferred.delete(key);
          }
          if (row.collectionNo) attach(row, stop);
          continue;
        }

        const existing = key ? stopByCustomer.get(key) : undefined;
        if (existing) {
          attach(row, existing);
        } else if (key && invoiceCustomers.has(key)) {
          // This customer's invoice row is further down the sheet. Hold the
          // collection rather than opening a second stop at the same address.
          const queue = deferred.get(key) ?? [];
          queue.push(row);
          deferred.set(key, queue);
        } else {
          const stop = makeStop(row);
          if (key) stopByCustomer.set(key, stop);
          attach(row, stop);
        }
      }

      // The pass above always drains this. Handled anyway rather than asserted:
      // a dropped collection is invisible until a driver is standing in front of
      // goods that are not on their sheet.
      for (const [key, queue] of deferred) {
        for (const row of queue) {
          const stop = makeStop(row);
          stopByCustomer.set(key, stop);
          attach(row, stop);
        }
      }

      stops.forEach((stop, idx) => {
        stop.stopNumber = idx + 1;
      });

      return { stops, unmatchedInvoices, unmatchedCollections };
    };

    for (const [, group] of driverGroupMap) {
      driverResults.push({
        driverId: group.driver.id,
        driverName: group.driver.name,
        regNo: group.rows[0]?.regNo || "",
        ...buildStops(group.rows, () => group.driver.name),
      });
    }

    // Handle unassigned rows (no driver found)
    if (unassignedRows.length > 0) {
      driverResults.push({
        driverId: "__unassigned__",
        driverName: unassignedRows[0]?.driverName || "Unassigned",
        regNo: unassignedRows[0]?.regNo || "",
        ...buildStops(unassignedRows, (row) => row.driverName || "Unassigned"),
      });
    }

    // 7. Detect invoices that were already signed (DB or filesystem)
    const allInvoiceNumbers = parsedRows.map((r) => r.invoiceNumber).filter(Boolean);
    const alreadySigned = await detectAlreadySignedInvoices(
      tenantId,
      allInvoiceNumbers,
      invoiceFiles
    );

    return {
      success: true,
      rows: parsedRows,
      driverResults,
      totalRows: parsedRows.length,
      matchedInvoices: totalMatched,
      unmatchedInvoices: totalUnmatched,
      totalCollections,
      matchedCollections,
      unmatchedCollections: unmatchedCollectionCount,
      // Only worth saying when the sheet actually carries collections.
      ...(collectionFolder.error && totalCollections > 0
        ? { collectionsFolderError: collectionFolder.error }
        : {}),
      alreadySigned,
      missingInvoices,
    };
  } catch (err) {
    return emptyResult(
      `Failed to parse file: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─── Already-Signed Invoice Detection ────────────────────────────────────

/**
 * Check if any invoice numbers in the trip sheet have already been signed.
 * Checks two sources:
 *   1. Database: stops with status=SIGNED matching these invoice numbers
 *   2. Filesystem: files in the signed/ subfolder of the invoice folder
 *
 * Both sources are scoped. Invoice numbers are usually sequential per company,
 * so an unscoped query here would very often collide with another ADMIN's rows
 * and disclose their driver's name and signing time.
 */
async function detectAlreadySignedInvoices(
  tenantId: string,
  invoiceNumbers: string[],
  invoiceFiles: { filename: string; invoiceNumber: string; isSigned: boolean; signedAt?: string }[]
): Promise<AlreadySignedInvoice[]> {
  if (invoiceNumbers.length === 0) return [];

  const results: AlreadySignedInvoice[] = [];
  const seen = new Set<string>();

  // Source 1: Check this scope's database for stops already signed with these
  // invoice numbers
  const signedStops = await scopedPrisma(tenantId).stop.findMany({
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

// ─── Deploy-time re-check ─────────────────────────────────────────────────

/**
 * The stops that would be deployed with no invoice PDF behind them.
 *
 * Both deploy routes re-parse the sheet before writing, so this runs against a
 * *fresh* listing of the invoice folder — not the one the dispatcher saw in the
 * preview. That is the point: an invoice uploaded (or deleted) between preview
 * and deploy is accounted for, and a stale browser tab cannot push stops the
 * driver has no paperwork for.
 *
 * Rows the sheet left unassigned are only counted once a driver has been chosen
 * for them; otherwise they are not being deployed at all.
 *
 * A collection-only stop carries no invoice number and is skipped: there is no
 * invoice for it to be missing. The rule is about DELIVERIES — a stop that
 * claims to deliver an invoice must have that invoice's PDF, because the
 * signature is embedded on it. Nothing is being delivered at a collection-only
 * stop, and its own paperwork is produced at signing time by
 * buildSignedCollectionPdf. This is not an override: the exemption keys on the
 * stop having no invoice number at all, and a row with a blank invoice cell and
 * no collection number never became a stop in the first place.
 */
export function collectMissingInvoices(
  driverResults: MatchResult[],
  skipInvoices: Set<string>,
  options: { includeUnassigned?: boolean } = {}
): MissingInvoice[] {
  const missing: MissingInvoice[] = [];

  for (const result of driverResults) {
    if (result.driverId === "__unassigned__" && !options.includeUnassigned) {
      continue;
    }

    for (const stop of result.stops) {
      if (!stop.invoiceNumber) continue; // collection-only stop — see above
      if (stop.invoiceFile) continue;
      if (skipInvoices.has(stop.invoiceNumber.toUpperCase())) continue;

      missing.push({
        invoiceNumber: stop.invoiceNumber,
        customerName: stop.customerName,
        driverName: result.driverName,
        stopId: stop.id,
      });
    }
  }

  return missing;
}
