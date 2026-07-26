/**
 * Backup utilities — archive old signed invoices and completed trip sheets.
 *
 * "Backupable" items:
 *   - Signed invoices: PDFs in the invoices/signed/ subfolder
 *   - Completed trip sheets: trip sheets where ALL stops have status SIGNED
 *
 * The ZIP archive layout:
 *   backup-YYYY-MM-DD/
 *     signed-invoices/     ← signed PDF files
 *     trip-sheets/         ← JSON export per trip sheet
 *     manifest.json        ← summary + timestamps
 *
 * Scoped throughout: `tenantId` is required, so a backup can only ever contain
 * one ADMIN's invoices and trip sheets, and a purge can only ever delete theirs.
 */

import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { scopedPrisma } from "./db-scoped";
import { getInvoiceFolderPath } from "./invoices";
import {
  getOneDriveInvoiceSource,
  listOneDriveSignedInvoices,
  downloadFileById,
} from "./microsoft-graph";

// ─── Types ────────────────────────────────────────────────────────────────

export interface BackupableInvoice {
  filename: string;
  sizeBytes: number;
  signedAt: string;
}

export interface BackupableTripSheet {
  id: string;
  driverName: string;
  regNo: string;
  date: string;
  sourceFilename: string;
  stopCount: number;
  uploadedBy: string;
}

export interface BackupSummary {
  invoices: BackupableInvoice[];
  tripSheets: BackupableTripSheet[];
  totalInvoices: number;
  totalTripSheets: number;
}

// ─── Query backupable items ───────────────────────────────────────────────

/**
 * List signed invoices eligible for backup.
 * Optionally filter to invoices signed before a given date.
 */
export async function getBackupableInvoices(
  tenantId: string,
  beforeDate?: Date
): Promise<BackupableInvoice[]> {
  const onedrive = await getOneDriveInvoiceSource(tenantId);
  if (onedrive) {
    return getBackupableInvoicesFromOneDrive(tenantId, beforeDate);
  }

  const folderPath = await getInvoiceFolderPath(tenantId);
  const signedFolder = path.join(folderPath, "signed");

  if (!fs.existsSync(signedFolder)) return [];

  const files = fs.readdirSync(signedFolder);
  const pdfFiles = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

  const results: BackupableInvoice[] = [];
  for (const filename of pdfFiles) {
    try {
      const filePath = path.join(signedFolder, filename);
      const stats = fs.statSync(filePath);
      const signedAt = stats.mtime;

      if (beforeDate && signedAt >= beforeDate) continue;

      results.push({
        filename,
        sizeBytes: stats.size,
        signedAt: signedAt.toISOString(),
      });
    } catch {
      // skip files we can't stat
    }
  }

  // Sort oldest first
  results.sort(
    (a, b) => new Date(a.signedAt).getTime() - new Date(b.signedAt).getTime()
  );

  return results;
}

async function getBackupableInvoicesFromOneDrive(
  tenantId: string,
  beforeDate?: Date
): Promise<BackupableInvoice[]> {
  const items = await listOneDriveSignedInvoices(tenantId);
  const results: BackupableInvoice[] = [];

  for (const item of items) {
    const signedAt = new Date(item.lastModifiedDateTime);
    if (beforeDate && signedAt >= beforeDate) continue;

    results.push({
      filename: item.name,
      sizeBytes: item.size,
      signedAt: signedAt.toISOString(),
    });
  }

  results.sort(
    (a, b) => new Date(a.signedAt).getTime() - new Date(b.signedAt).getTime()
  );

  return results;
}

/**
 * List completed trip sheets eligible for backup.
 * A trip sheet is "complete" when ALL its stops are SIGNED.
 * Optionally filter to trip sheets created before a given date.
 */
export async function getBackupableTripSheets(
  tenantId: string,
  beforeDate?: Date
): Promise<BackupableTripSheet[]> {
  const whereClause: Record<string, unknown> = {};
  if (beforeDate) {
    whereClause.date = { lt: beforeDate };
  }

  // Get trip sheets with their stop counts
  const tripSheets = await scopedPrisma(tenantId).tripSheet.findMany({
    where: whereClause,
    orderBy: { date: "asc" },
    include: {
      driver: { select: { name: true } },
      _count: { select: { stops: true } },
      stops: { select: { status: true } },
    },
  });

  const results: BackupableTripSheet[] = [];
  for (const ts of tripSheets) {
    // Only include if ALL stops are SIGNED (and there's at least one stop)
    if (ts.stops.length === 0) continue;
    const allSigned = ts.stops.every((s) => s.status === "SIGNED");
    if (!allSigned) continue;

    results.push({
      id: ts.id,
      driverName: ts.driver?.name || "Unknown",
      regNo: ts.regNo || "",
      date: ts.date.toISOString(),
      sourceFilename: ts.sourceFilename,
      stopCount: ts._count.stops,
      uploadedBy: ts.uploadedBy,
    });
  }

  return results;
}

/**
 * Get a combined summary of all backupable items.
 */
export async function getBackupSummary(
  tenantId: string,
  beforeDate?: Date
): Promise<BackupSummary> {
  const [invoices, tripSheets] = await Promise.all([
    getBackupableInvoices(tenantId, beforeDate),
    getBackupableTripSheets(tenantId, beforeDate),
  ]);

  return {
    invoices,
    tripSheets,
    totalInvoices: invoices.length,
    totalTripSheets: tripSheets.length,
  };
}

// ─── Create ZIP archive ───────────────────────────────────────────────────

/**
 * Build a ZIP archive containing the selected signed invoices and trip sheet
 * data exports. Returns the ZIP as a Buffer.
 */
export async function createBackupZip(
  tenantId: string,
  invoiceFilenames: string[],
  tripSheetIds: string[]
): Promise<Buffer> {
  const zip = new JSZip();
  const datestamp = new Date().toISOString().slice(0, 10);
  const prefix = `backup-${datestamp}`;

  // ── Signed invoices ──────────────────────────────────────────────
  if (invoiceFilenames.length > 0) {
    const onedrive = await getOneDriveInvoiceSource(tenantId);
    if (onedrive) {
      const items = await listOneDriveSignedInvoices(tenantId);
      for (const filename of invoiceFilenames) {
        const item = items.find((i) => i.name === filename);
        if (!item) continue;
        try {
          const fileData = await downloadFileById(tenantId, item.id);
          zip.file(`${prefix}/signed-invoices/${filename}`, fileData);
        } catch {
          // skip files we can't download
        }
      }
    } else {
      const folderPath = await getInvoiceFolderPath(tenantId);
      const signedFolder = path.join(folderPath, "signed");

      for (const filename of invoiceFilenames) {
        const filePath = path.join(signedFolder, filename);
        // Security: prevent directory traversal
        const resolved = path.resolve(filePath);
        const resolvedFolder = path.resolve(signedFolder);
        if (!resolved.startsWith(resolvedFolder)) continue;

        if (fs.existsSync(resolved)) {
          const fileData = fs.readFileSync(resolved);
          zip.file(`${prefix}/signed-invoices/${filename}`, fileData);
        }
      }
    }
  }

  // ── Trip sheet JSON exports ──────────────────────────────────────
  if (tripSheetIds.length > 0) {
    const tripSheets = await scopedPrisma(tenantId).tripSheet.findMany({
      where: { id: { in: tripSheetIds } },
      include: {
        driver: { select: { name: true } },
        stops: { orderBy: { stopNumber: "asc" } },
      },
    });

    for (const ts of tripSheets) {
      const exportData = {
        id: ts.id,
        driverName: ts.driver?.name || "Unknown",
        regNo: ts.regNo || "",
        date: ts.date.toISOString(),
        sourceFilename: ts.sourceFilename,
        uploadedBy: ts.uploadedBy,
        createdAt: ts.createdAt.toISOString(),
        stops: ts.stops.map((s) => ({
          stopNumber: s.stopNumber,
          invoiceNumber: s.invoiceNumber,
          customerName: s.customerName,
          address: s.address,
          nop: s.nop,
          invoiceFile: s.invoiceFile,
          status: s.status,
          signedAt: s.signedAt?.toISOString() || null,
          signatureData: s.signatureData,
        })),
      };

      const safeName =
        ts.sourceFilename.replace(/[^a-zA-Z0-9_\-.]/g, "_") || ts.id;
      zip.file(
        `${prefix}/trip-sheets/${safeName}_${ts.id.slice(0, 8)}.json`,
        JSON.stringify(exportData, null, 2)
      );
    }
  }

  // ── Manifest ─────────────────────────────────────────────────────
  const manifest = {
    createdAt: new Date().toISOString(),
    version: "1.0",
    contents: {
      signedInvoices: invoiceFilenames.length,
      tripSheets: tripSheetIds.length,
    },
    invoiceFilenames,
    tripSheetIds,
  };

  zip.file(`${prefix}/manifest.json`, JSON.stringify(manifest, null, 2));

  // Generate the ZIP as a Node.js Buffer
  const buf = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return buf;
}

// ─── Purge operations ─────────────────────────────────────────────────────

/**
 * Delete signed invoice PDFs from the filesystem.
 * Only removes from the signed/ subfolder (not originals).
 */
export async function purgeBackedUpInvoices(
  tenantId: string,
  filenames: string[]
): Promise<{ deleted: number; failed: string[] }> {
  const folderPath = await getInvoiceFolderPath(tenantId);
  const signedFolder = path.join(folderPath, "signed");
  let deleted = 0;
  const failed: string[] = [];

  for (const filename of filenames) {
    const filePath = path.join(signedFolder, filename);
    const resolved = path.resolve(filePath);
    const resolvedFolder = path.resolve(signedFolder);

    if (!resolved.startsWith(resolvedFolder)) {
      failed.push(filename);
      continue;
    }

    try {
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
        deleted++;
      } else {
        // Already gone — count as success
        deleted++;
      }
    } catch {
      failed.push(filename);
    }
  }

  return { deleted, failed };
}

/**
 * Delete completed trip sheets and their stops from the database.
 * Cascade deletes handle stops automatically.
 */
export async function purgeBackedUpTripSheets(
  tenantId: string,
  tripSheetIds: string[]
): Promise<{ deleted: number; failed: string[] }> {
  const db = scopedPrisma(tenantId);
  let deleted = 0;
  const failed: string[] = [];

  for (const id of tripSheetIds) {
    try {
      // deleteMany, not delete: an id outside this scope matches zero rows and
      // is reported as failed rather than throwing.
      const res = await db.tripSheet.deleteMany({ where: { id } });
      if (res.count > 0) {
        deleted++;
      } else {
        failed.push(id);
      }
    } catch {
      failed.push(id);
    }
  }

  return { deleted, failed };
}
