/**
 * Collection file utilities and the record-an-outcome path.
 *
 * A collection is the mirror image of a delivery: the driver takes goods AWAY
 * from the customer and captures a signature for it. This module is to
 * collections what lib/invoices.ts is to invoices, and deliberately mirrors it —
 * same folder-resolution order, same OneDrive-first/local-fallback structure,
 * same traversal guards, same filename sanitising.
 *
 * Every function takes `tenantId` first and it is REQUIRED. The folder path is
 * read from that scope's AppConfig and any OneDrive access uses that scope's own
 * connection, so one ADMIN can neither list, read, sign nor download another's
 * collection documents.
 *
 * ── The folder is a SIBLING of the invoice folder ─────────────────────────
 * Not a subfolder. `listInvoiceFiles` enumerates the invoice folder and treats
 * every PDF in it as an invoice, so a Collections folder nested inside it would
 * turn every collection document into a phantom invoice — and the reverse for a
 * nested invoice folder. `assertCollectionsFolderIsSibling` refuses both
 * arrangements at configuration time rather than leaving them to be discovered
 * as mismatched paperwork at a customer's door.
 *
 *   /Signex/{Tenant}/Invoices      ← invoices + invoices/signed
 *   /Signex/{Tenant}/Collections   ← Pending/ + Signed/
 */

import fs from "fs";
import path from "path";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { CollectionStatus, CollectionType, UpliftSubtype } from "@prisma/client";
import { readConfig } from "./config";
import {
  getOneDriveCollectionsSource,
  listOneDriveCollectionDocuments,
  listOneDriveSignedCollections,
  downloadCollectionByName,
  downloadSignedCollectionByName,
  uploadSignedCollectionToOneDrive,
  getCollectionItemByName,
} from "./microsoft-graph";

/** Default fallback folder (relative to project root), as invoices does. */
const DEFAULT_FOLDER = path.join(process.cwd(), "collections");

/**
 * Subfolders of the collections folder.
 *
 * Pending holds documents the office has produced and the driver has not yet
 * actioned. Signed holds the stamped output and is permanent — nothing is
 * deleted or moved out of it when a trip is closed, because it is the physical
 * record behind a credit note.
 */
export const PENDING_SUBFOLDER = "Pending";
export const SIGNED_SUBFOLDER = "Signed";

/** Get this scope's collections folder path (config DB → env var → default). */
export async function getCollectionsFolderPath(tenantId: string): Promise<string> {
  const config = await readConfig(tenantId);
  if (config.collectionsFolderPath && config.collectionsFolderPath.trim() !== "") {
    return config.collectionsFolderPath;
  }
  return process.env.COLLECTIONS_FOLDER_PATH || DEFAULT_FOLDER;
}

// ─── Sibling check ────────────────────────────────────────────────────────

/** Normalise a path for containment comparison. Windows paths are case-blind. */
function normalizeForCompare(p: string): string {
  return path
    .resolve(p)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

/** True when `child` is `parent` or sits underneath it. */
function isWithin(parent: string, child: string): boolean {
  const a = normalizeForCompare(parent);
  const b = normalizeForCompare(child);
  if (a === b) return true;
  return b.startsWith(a + path.sep) || b.startsWith(a + "/");
}

export interface SiblingCheck {
  ok: boolean;
  error?: string;
}

/**
 * Refuse a collections folder that overlaps the invoice folder, in either
 * direction.
 *
 * The two listings are extension-based — every PDF in the invoice folder is an
 * invoice, every PDF in Collections/Pending is a collection document. Nesting
 * one inside the other silently cross-contaminates both, and the failure shows
 * up as a driver holding the wrong paperwork rather than as an error. Cheaper to
 * refuse the configuration.
 */
export function assertCollectionsFolderIsSibling(
  invoiceFolderPath: string | null | undefined,
  collectionsFolderPath: string | null | undefined
): SiblingCheck {
  const inv = (invoiceFolderPath ?? "").trim();
  const col = (collectionsFolderPath ?? "").trim();
  if (!inv || !col) return { ok: true };

  if (isWithin(inv, col)) {
    return {
      ok: false,
      error:
        "The collections folder is inside the invoice folder. Every PDF in the invoice folder is treated as an invoice, so collection documents would be matched to stops as invoices. Put Collections alongside Invoices, not inside it.",
    };
  }

  if (isWithin(col, inv)) {
    return {
      ok: false,
      error:
        "The invoice folder is inside the collections folder. Invoices would be picked up as pending collection documents. Put Collections alongside Invoices, not around it.",
    };
  }

  return { ok: true };
}

// ─── Collection number normalisation ──────────────────────────────────────

/**
 * Normalise a collection number for filename matching.
 *
 * Mirrors normalizeInvoiceNumber in lib/trip-parser.ts: same strip-prefix,
 * strip-separator, keep-leading-zeros rules, with the prefixes an office
 * actually writes on collection paperwork ("COL-", "COLL ", "CR#", "UPL-").
 * Matching is filename-based, so both sides go through this before comparison.
 */
export function normalizeCollectionNumber(raw: string): string {
  let normalized = String(raw ?? "").trim().toUpperCase();

  normalized = normalized.replace(/\.PDF$/i, "");

  normalized = normalized
    .replace(/^COLLECTION\s*#\s*/i, "")
    .replace(/^COLLECTION\s+/i, "")
    .replace(/^COLL?[\s\-.#]*/i, "")
    .replace(/^CR[\s\-.#]+/i, "")
    .replace(/^UPL[\s\-.#]*/i, "");

  normalized = normalized.replace(/[\s\-]/g, "");

  return normalized;
}

/** Characters Windows refuses in a filename, plus the path separators. */
const ILLEGAL_FILENAME_CHARS = /[<>:"|?*\\/]/g;

/**
 * Reduce a caller-supplied name to a safe collection filename, or null.
 *
 * Identical treatment to sanitizeInvoiceFilename: these names reach Graph path
 * addressing, which reads "/" as a separator and ".." as a parent.
 */
export function sanitizeCollectionFilename(raw: string): string | null {
  const base = String(raw ?? "")
    .split(/[\\/]/)
    .pop() ?? "";

  const stripped = Array.from(base.trim())
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .replace(ILLEGAL_FILENAME_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!stripped || stripped === "." || stripped === "..") return null;

  const withoutExt = stripped.replace(/\.pdf$/i, "").replace(/\.+$/, "").trim();
  if (!withoutExt) return null;

  return `${withoutExt.slice(0, 180)}.pdf`;
}

/**
 * The name a stamped collection document is filed under.
 *
 * The original filename pattern plus a status suffix, so Signed/ sorts next to
 * the paperwork it came from and accounts can see the outcome without opening
 * the file. A collection with no source document is named from its number, which
 * is the same thing the source document would have been named.
 */
export function signedCollectionFilename(
  sourceFilename: string | null | undefined,
  collectionNo: string,
  status: CollectionStatus
): string | null {
  const base = sourceFilename
    ? sourceFilename.replace(/\.pdf$/i, "")
    : String(collectionNo ?? "").trim();

  return sanitizeCollectionFilename(`${base}_${status}`);
}

// ─── Listing pending / signed documents ───────────────────────────────────

export interface CollectionDocument {
  /** Filename without extension */
  name: string;
  /** Full filename with extension */
  filename: string;
  sizeBytes: number;
  lastModified: string;
  /** Collection number extracted from the filename */
  collectionNo: string;
  /** OneDrive item id, when the source is OneDrive */
  itemId?: string;
}

/** Where a scope's collection documents were read from, and what was found. */
export interface CollectionsFolderListing {
  /** "onedrive" when a OneDrive collections folder is chosen, else "local" */
  source: "onedrive" | "local";
  /** The configured folder, as the admin chose it */
  folderPath: string | null;
  documents: CollectionDocument[];
  /**
   * Why the listing could not be trusted, if it could not. Reported rather than
   * swallowed: an unreadable folder used to come back as an empty one, so every
   * collection on a sheet read as "no document" with nothing to say why.
   */
  error?: string;
}

/**
 * List the pending collection documents for this scope, saying where it looked.
 *
 * Reads Collections/Pending and PDFs directly in the collections folder — see
 * listOneDriveCollectionDocuments for why both. Signed/ is never included: a
 * stamped document is no longer outstanding work. Uses OneDrive when a
 * collections folder is chosen there, otherwise the configured local folder,
 * exactly as listInvoiceFiles resolves.
 */
export async function listCollectionFolder(
  tenantId: string
): Promise<CollectionsFolderListing> {
  const onedrive = await getOneDriveCollectionsSource(tenantId);
  if (onedrive) {
    const folderPath = onedrive.folderPath ?? null;
    try {
      const items = await listOneDriveCollectionDocuments(tenantId);
      const documents = items.map((item) => {
        const name = item.name.replace(/\.pdf$/i, "");
        return {
          name,
          filename: item.name,
          sizeBytes: item.size,
          lastModified: item.lastModifiedDateTime,
          collectionNo: name.toUpperCase(),
          itemId: item.id,
        };
      });
      return { source: "onedrive", folderPath, documents };
    } catch (err) {
      console.error("Failed to list OneDrive collection documents:", err);
      return {
        source: "onedrive",
        folderPath,
        documents: [],
        error: `Could not read the OneDrive collections folder: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  const folderPath = await getCollectionsFolderPath(tenantId);
  if (!fs.existsSync(folderPath)) {
    // The usual cause on the hosted app: a local path was chosen in Settings,
    // and the server has no such disk. Only a OneDrive folder is reachable there.
    return {
      source: "local",
      folderPath,
      documents: [],
      error: `The collections folder "${folderPath}" does not exist on the server. Choose a OneDrive collections folder in Settings.`,
    };
  }
  return { source: "local", folderPath, documents: listCollectionDocumentsFromLocal(folderPath) };
}

/** The pending documents alone, for callers that only match against them. */
export async function listCollectionDocuments(
  tenantId: string
): Promise<CollectionDocument[]> {
  return (await listCollectionFolder(tenantId)).documents;
}

function readPdfDir(folder: string): CollectionDocument[] {
  if (!fs.existsSync(folder)) return [];

  const results: CollectionDocument[] = [];
  for (const filename of fs.readdirSync(folder)) {
    if (!filename.toLowerCase().endsWith(".pdf")) continue;
    try {
      const stats = fs.statSync(path.join(folder, filename));
      if (!stats.isFile()) continue;
      const name = path.parse(filename).name;
      results.push({
        name,
        filename,
        sizeBytes: stats.size,
        lastModified: stats.mtime.toISOString(),
        collectionNo: name.toUpperCase(),
      });
    } catch {
      // skip files we can't stat
    }
  }
  return results;
}

/** Pending/ first, then the folder root; on a name clash Pending/ wins. */
function listCollectionDocumentsFromLocal(folderPath: string): CollectionDocument[] {
  const pending = readPdfDir(path.join(folderPath, PENDING_SUBFOLDER));
  const seen = new Set(pending.map((d) => d.filename.toLowerCase()));
  const root = readPdfDir(folderPath).filter((d) => !seen.has(d.filename.toLowerCase()));
  return [...pending, ...root];
}

/** List the stamped documents in Collections/Signed for this scope. */
export async function listSignedCollectionDocuments(
  tenantId: string
): Promise<CollectionDocument[]> {
  const onedrive = await getOneDriveCollectionsSource(tenantId);
  if (onedrive) {
    try {
      const items = await listOneDriveSignedCollections(tenantId);
      return items.map((item) => {
        const name = item.name.replace(/\.pdf$/i, "");
        return {
          name,
          filename: item.name,
          sizeBytes: item.size,
          lastModified: item.lastModifiedDateTime,
          collectionNo: name.toUpperCase(),
          itemId: item.id,
        };
      });
    } catch (err) {
      console.error("Failed to list OneDrive signed collections:", err);
      return [];
    }
  }

  const folderPath = await getCollectionsFolderPath(tenantId);
  return readPdfDir(path.join(folderPath, SIGNED_SUBFOLDER));
}

/**
 * Build the collection-number → document lookup used when a trip sheet is
 * parsed.
 *
 * Same two-key scheme as the invoice lookup in lib/trip-parser.ts: the
 * normalised number and its digits-only form, so "CR-00412" on the sheet still
 * finds "412.pdf" in the folder.
 */
export function buildCollectionLookup(
  documents: CollectionDocument[]
): Map<string, CollectionDocument> {
  const lookup = new Map<string, CollectionDocument>();
  for (const doc of documents) {
    const normalized = normalizeCollectionNumber(doc.collectionNo);
    if (normalized && !lookup.has(normalized)) lookup.set(normalized, doc);
    const numericOnly = normalized.replace(/\D/g, "");
    if (numericOnly && !lookup.has(numericOnly)) lookup.set(numericOnly, doc);
  }
  return lookup;
}

/** Look one collection number up in a lookup built above. */
export function matchCollectionDocument(
  lookup: Map<string, CollectionDocument>,
  collectionNo: string
): CollectionDocument | undefined {
  const normalized = normalizeCollectionNumber(collectionNo);
  return lookup.get(normalized) || lookup.get(normalized.replace(/\D/g, ""));
}

// ─── Reading a document ───────────────────────────────────────────────────

function resolveWithinFolder(folderPath: string, ...segments: string[]): string {
  const target = path.join(folderPath, ...segments);
  const resolved = path.resolve(target);
  const resolvedFolder = path.resolve(folderPath);
  if (!resolved.startsWith(resolvedFolder)) {
    throw new Error("Invalid filename — directory traversal detected");
  }
  return resolved;
}

/** Read a pending collection document as a Buffer, or null if it isn't there. */
export async function readCollectionDocument(
  tenantId: string,
  filename: string
): Promise<Buffer | null> {
  const onedrive = await getOneDriveCollectionsSource(tenantId);
  if (onedrive) {
    try {
      return await downloadCollectionByName(tenantId, filename);
    } catch (err) {
      console.error(`Failed to read collection ${filename} from OneDrive:`, err);
      return null;
    }
  }

  // Pending/ first, then the folder root, as listCollectionFolder lists them.
  const folderPath = await getCollectionsFolderPath(tenantId);
  for (const resolved of [
    resolveWithinFolder(folderPath, PENDING_SUBFOLDER, filename),
    resolveWithinFolder(folderPath, filename),
  ]) {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return fs.readFileSync(resolved);
    }
  }
  return null;
}

/** Read a stamped collection document from Signed/. */
export async function readSignedCollectionDocument(
  tenantId: string,
  filename: string
): Promise<Buffer | null> {
  const onedrive = await getOneDriveCollectionsSource(tenantId);
  if (onedrive) {
    try {
      return await downloadSignedCollectionByName(tenantId, filename);
    } catch (err) {
      console.error(`Failed to read signed collection ${filename} from OneDrive:`, err);
      return null;
    }
  }

  const folderPath = await getCollectionsFolderPath(tenantId);
  const resolved = resolveWithinFolder(folderPath, SIGNED_SUBFOLDER, filename);
  if (!fs.existsSync(resolved)) return null;
  return fs.readFileSync(resolved);
}

export interface SavedCollectionFile {
  /** Where it landed — a OneDrive marker or an absolute local path */
  filePath: string;
  /** OneDrive item id, when the destination was OneDrive */
  fileId?: string;
}

/**
 * Write a stamped collection document into Collections/Signed.
 *
 * Overwrites on purpose, unlike an invoice upload: this is output we produced
 * from a record we hold, so re-running it must converge rather than 409. A
 * collection can only be re-stamped by a deliberate ADMIN correction, and the
 * corrected document is the one that should be on file.
 */
export async function saveSignedCollection(
  tenantId: string,
  filename: string,
  pdfBuffer: Buffer
): Promise<SavedCollectionFile> {
  const onedrive = await getOneDriveCollectionsSource(tenantId);
  if (onedrive) {
    const item = await uploadSignedCollectionToOneDrive(tenantId, filename, pdfBuffer);
    return {
      filePath: `${onedrive.folderPath || "Collections"}/${SIGNED_SUBFOLDER}/${filename}`,
      fileId: item.id,
    };
  }

  const folderPath = await getCollectionsFolderPath(tenantId);
  const signedFolder = path.join(folderPath, SIGNED_SUBFOLDER);
  if (!fs.existsSync(signedFolder)) {
    fs.mkdirSync(signedFolder, { recursive: true });
  }

  const resolved = resolveWithinFolder(folderPath, SIGNED_SUBFOLDER, filename);
  fs.writeFileSync(resolved, pdfBuffer);
  return { filePath: resolved };
}

/** Resolve the id of a pending document, for recording on the Collection row. */
export async function getCollectionDocumentId(
  tenantId: string,
  filename: string
): Promise<string | undefined> {
  const onedrive = await getOneDriveCollectionsSource(tenantId);
  if (!onedrive) return undefined;
  try {
    const item = await getCollectionItemByName(tenantId, filename);
    return item?.id;
  } catch {
    return undefined;
  }
}

// ─── Outcome validation ───────────────────────────────────────────────────

/** Statuses that close a collection out. Everything else is still outstanding. */
export const TERMINAL_STATUSES: CollectionStatus[] = [
  "COLLECTED",
  "PARTIAL",
  "NOT_AVAILABLE",
  "REFUSED",
];

/** Statuses that require the driver to say what went wrong. */
export const EXCEPTION_STATUSES: CollectionStatus[] = [
  "PARTIAL",
  "NOT_AVAILABLE",
  "REFUSED",
];

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as string[]).includes(status);
}

export function isExceptionStatus(status: string): boolean {
  return (EXCEPTION_STATUSES as string[]).includes(status);
}

export interface CollectionOutcomeInput {
  status: CollectionStatus;
  exceptionReason?: string | null;
  collectedQty?: number | null;
  expectedQty?: number | null;
  signedByName?: string | null;
  signatureImage?: string | null;
}

export interface OutcomeValidation {
  ok: boolean;
  error?: string;
}

/**
 * Check an outcome the driver is about to submit.
 *
 * The exception reason is mandatory on PARTIAL / NOT_AVAILABLE / REFUSED because
 * the whole point of the three separate states is that accounts acts on them
 * differently — an unexplained PARTIAL tells them a credit is wrong without
 * telling them what to raise it for.
 *
 * A signature is required whenever anything actually changed hands (COLLECTED,
 * PARTIAL) and deliberately NOT required for NOT_AVAILABLE or REFUSED: there is
 * nothing for the customer to sign for, and demanding one would leave a driver
 * unable to close out a stop the customer has turned away.
 */
export function validateCollectionOutcome(
  input: CollectionOutcomeInput
): OutcomeValidation {
  if (!isTerminalStatus(input.status)) {
    return {
      ok: false,
      error: `Invalid outcome. Use one of: ${TERMINAL_STATUSES.join(", ")}`,
    };
  }

  if (isExceptionStatus(input.status) && !input.exceptionReason?.trim()) {
    return {
      ok: false,
      error: "A reason is required when a collection is partial, unavailable or refused",
    };
  }

  const tookSomething = input.status === "COLLECTED" || input.status === "PARTIAL";

  if (tookSomething && !input.signatureImage) {
    return { ok: false, error: "A customer signature is required for a collection" };
  }

  if (tookSomething && !input.signedByName?.trim()) {
    return { ok: false, error: "The name of the person signing is required" };
  }

  if (
    input.collectedQty !== undefined &&
    input.collectedQty !== null &&
    (!Number.isInteger(input.collectedQty) || input.collectedQty < 0)
  ) {
    return { ok: false, error: "Collected quantity must be a whole number of 0 or more" };
  }

  if (
    input.status === "PARTIAL" &&
    input.expectedQty != null &&
    input.collectedQty != null &&
    input.collectedQty >= input.expectedQty
  ) {
    return {
      ok: false,
      error: "A partial collection must be fewer than the expected quantity",
    };
  }

  return { ok: true };
}

/**
 * Check the type/subtype pairing.
 *
 * NON_CREDIT_UPLIFT without a subtype is meaningless to whoever books it in, and
 * SPECIAL_REQUEST without a note is a subtype that says only "something else".
 */
export function validateCollectionType(
  type: CollectionType,
  upliftSubtype: UpliftSubtype | null | undefined,
  notes: string | null | undefined
): OutcomeValidation {
  if (type === "NON_CREDIT_UPLIFT") {
    if (!upliftSubtype) {
      return { ok: false, error: "An uplift needs a subtype" };
    }
    if (upliftSubtype === "SPECIAL_REQUEST" && !notes?.trim()) {
      return { ok: false, error: "A special request needs a note describing it" };
    }
  }
  return { ok: true };
}

// ─── Stamping ─────────────────────────────────────────────────────────────

export interface CollectionReceiptData {
  collectionNo: string;
  type: CollectionType;
  upliftSubtype?: UpliftSubtype | null;
  originalInvoiceNo?: string | null;
  status: CollectionStatus;
  expectedQty?: number | null;
  collectedQty?: number | null;
  exceptionReason?: string | null;
  notes?: string | null;
  customerName: string;
  signedByName?: string | null;
  driverName?: string | null;
  collectedAt: Date;
}

export const COLLECTION_TYPE_LABEL: Record<CollectionType, string> = {
  CREDIT_RETURN: "Credit Return",
  NON_CREDIT_UPLIFT: "Uplift (non-credit)",
};

export const UPLIFT_SUBTYPE_LABEL: Record<UpliftSubtype, string> = {
  COMPANY_PARCEL: "Company parcel",
  EQUIPMENT_OR_CRATES: "Equipment / crates",
  DOCUMENTS: "Documents",
  SPECIAL_REQUEST: "Special request",
};

export const COLLECTION_STATUS_LABEL: Record<CollectionStatus, string> = {
  PENDING: "Pending",
  COLLECTED: "Collected",
  PARTIAL: "Partially collected",
  NOT_AVAILABLE: "Not available",
  REFUSED: "Refused",
};

/** A4 in PDF points, for the generated receipt page. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

/**
 * Build the signed collection document.
 *
 * The record is drawn on its own appended page rather than stamped over the
 * source document. An invoice has a known layout and a configured signature
 * box; a collection document is whatever the office printed, and a collection
 * record is a dozen fields rather than a signature and a date. Overlaying that
 * on an unknown layout would sooner or later obscure the very line-items the
 * credit is raised against, so the source pages are left exactly as they were
 * and the receipt follows them.
 *
 * When there is no source document the output is the receipt page alone, which
 * is why NOT_AVAILABLE and REFUSED still produce a filed PDF: "we went and it
 * was not there" is a result accounts needs on paper too.
 */
export async function buildSignedCollectionPdf(
  sourcePdf: Buffer | null,
  data: CollectionReceiptData,
  signatureImageBytes?: Uint8Array | null
): Promise<Buffer> {
  const pdfDoc = sourcePdf
    ? await PDFDocument.load(sourcePdf)
    : await PDFDocument.create();

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const margin = 56;
  let y = PAGE_HEIGHT - margin;

  const ink = rgb(0.06, 0.06, 0.06);
  const muted = rgb(0.45, 0.45, 0.45);
  const rule = rgb(0.8, 0.8, 0.78);

  page.drawText("COLLECTION RECEIPT", {
    x: margin,
    y,
    size: 16,
    font: bold,
    color: ink,
  });
  y -= 10;
  page.drawLine({
    start: { x: margin, y },
    end: { x: PAGE_WIDTH - margin, y },
    thickness: 1,
    color: rule,
  });
  y -= 26;

  const typeLabel =
    data.type === "NON_CREDIT_UPLIFT" && data.upliftSubtype
      ? `${COLLECTION_TYPE_LABEL[data.type]} — ${UPLIFT_SUBTYPE_LABEL[data.upliftSubtype]}`
      : COLLECTION_TYPE_LABEL[data.type];

  const qty =
    data.collectedQty != null || data.expectedQty != null
      ? `${data.collectedQty ?? 0} of ${data.expectedQty ?? "—"}`
      : null;

  const rows: [string, string | null][] = [
    ["Collection No", data.collectionNo],
    ["Type", typeLabel],
    ["Original Invoice", data.originalInvoiceNo || null],
    ["Customer", data.customerName],
    ["Outcome", COLLECTION_STATUS_LABEL[data.status]],
    ["Quantity", qty],
    ["Reason", data.exceptionReason || null],
    ["Notes", data.notes || null],
    ["Driver", data.driverName || null],
    [
      "Date / time",
      data.collectedAt.toLocaleString("en-ZA", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    ],
  ];

  const labelWidth = 120;
  const valueWidth = PAGE_WIDTH - margin * 2 - labelWidth;

  for (const [label, value] of rows) {
    if (!value) continue;

    page.drawText(label.toUpperCase(), {
      x: margin,
      y,
      size: 8,
      font,
      color: muted,
    });

    // Wrap long values (a reason is free text a driver typed on a phone).
    const lines = wrapText(value, font, 10, valueWidth);
    for (const [i, line] of lines.entries()) {
      page.drawText(line, {
        x: margin + labelWidth,
        y: y - i * 13,
        size: 10,
        font: i === 0 ? bold : font,
        color: ink,
      });
    }

    y -= Math.max(22, lines.length * 13 + 9);
  }

  y -= 10;
  page.drawLine({
    start: { x: margin, y },
    end: { x: PAGE_WIDTH - margin, y },
    thickness: 0.5,
    color: rule,
  });
  y -= 28;

  page.drawText("CUSTOMER SIGNATURE", {
    x: margin,
    y,
    size: 8,
    font,
    color: muted,
  });
  y -= 12;

  if (signatureImageBytes && signatureImageBytes.length > 0) {
    const signatureImage = await pdfDoc.embedPng(signatureImageBytes);
    const maxWidth = 200;
    const maxHeight = 70;
    const dims = signatureImage.scale(1);
    const scale = Math.min(maxWidth / dims.width, maxHeight / dims.height, 1);
    const w = dims.width * scale;
    const h = dims.height * scale;

    page.drawImage(signatureImage, { x: margin, y: y - h, width: w, height: h });
    y -= h + 6;
  } else {
    // NOT_AVAILABLE / REFUSED: say so in the box rather than leaving a blank
    // line that reads as an unsigned document.
    page.drawText(
      data.status === "REFUSED"
        ? "Customer refused the collection — no signature taken"
        : "Nothing collected — no signature taken",
      { x: margin, y: y - 14, size: 9, font, color: muted }
    );
    y -= 26;
  }

  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + 240, y },
    thickness: 0.5,
    color: rule,
  });
  y -= 12;

  page.drawText(data.signedByName ? `Signed by ${data.signedByName}` : "Not signed", {
    x: margin,
    y,
    size: 9,
    font,
    color: muted,
  });

  pdfDoc.setSubject(`Collection:${data.collectionNo}:${data.status}`);

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

/** Greedy word wrap against an embedded font's real metrics. */
function wrapText(
  text: string,
  font: { widthOfTextAtSize: (t: string, s: number) => number },
  size: number,
  maxWidth: number
): string[] {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);

  // Six lines is enough for any reason a driver types; the rest is truncated
  // rather than allowed to run off the page.
  if (lines.length > 6) {
    return [...lines.slice(0, 5), `${lines[5]}…`];
  }
  return lines;
}
