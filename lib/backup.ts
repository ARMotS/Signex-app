/**
 * Backup utilities — archive old signed invoices and completed trip sheets.
 *
 * "Backupable" items:
 *   - Signed invoices: PDFs in the invoices/signed/ subfolder
 *   - Completed trip sheets: source files moved to the trip-sheet processed/
 *     subfolder when a trip sheet is completed/archived
 *
 * The ZIP archive layout:
 *   backup-YYYY-MM-DD/
 *     signed-invoices/     ← signed PDF files
 *     trip-sheets/         ← completed trip sheet source files (csv/xlsx)
 *     manifest.json        ← summary + timestamps
 */

import fs from "fs";
import path from "path";
import JSZip from "jszip";
import { getInvoiceFolderPath } from "./invoices";
import { getOneDriveSource, getTripSheetFolderPath } from "./trip-sheet-folder";
import {
  getOneDriveInvoiceSource,
  listOneDriveSignedInvoices,
  listOneDriveProcessedTripSheets,
  downloadFileById,
  deleteFileById,
} from "./microsoft-graph";

// ─── Types ────────────────────────────────────────────────────────────────

export interface BackupableInvoice {
  filename: string;
  sizeBytes: number;
  signedAt: string;
}

export interface BackupableTripSheet {
  /** The completed trip sheet file name in the processed/ folder (unique key) */
  filename: string;
  /** File size in bytes */
  sizeBytes: number;
  /** When the file was moved to processed/ (last-modified time) */
  processedAt: string;
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
  beforeDate?: Date
): Promise<BackupableInvoice[]> {
  const onedrive = await getOneDriveInvoiceSource();
  if (onedrive) {
    return getBackupableInvoicesFromOneDrive(beforeDate);
  }

  const folderPath = await getInvoiceFolderPath();
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
  beforeDate?: Date
): Promise<BackupableInvoice[]> {
  const items = await listOneDriveSignedInvoices();
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
 *
 * When a trip sheet is completed/archived, its source file is moved to the
 * "processed/" subfolder of the trip sheet folder (and the DB record is
 * removed). The backupable trip sheets are therefore the files sitting in
 * that processed/ folder — read from OneDrive if configured, otherwise from
 * the local filesystem.
 *
 * Optionally filter to files processed before a given date.
 */
export async function getBackupableTripSheets(
  beforeDate?: Date
): Promise<BackupableTripSheet[]> {
  const onedrive = await getOneDriveSource();
  if (onedrive) {
    return getBackupableTripSheetsFromOneDrive(beforeDate);
  }

  const folderPath = await getTripSheetFolderPath();
  if (!folderPath) return [];

  const processedFolder = path.join(folderPath, "processed");
  if (!fs.existsSync(processedFolder)) return [];

  const extensions = [".csv", ".xlsx", ".xls"];
  const files = fs
    .readdirSync(processedFolder)
    .filter((f) => extensions.includes(path.extname(f).toLowerCase()));

  const results: BackupableTripSheet[] = [];
  for (const filename of files) {
    try {
      const stats = fs.statSync(path.join(processedFolder, filename));
      const processedAt = stats.mtime;
      if (beforeDate && processedAt >= beforeDate) continue;

      results.push({
        filename,
        sizeBytes: stats.size,
        processedAt: processedAt.toISOString(),
      });
    } catch {
      // skip files we can't stat
    }
  }

  // Sort oldest first
  results.sort(
    (a, b) =>
      new Date(a.processedAt).getTime() - new Date(b.processedAt).getTime()
  );

  return results;
}

async function getBackupableTripSheetsFromOneDrive(
  beforeDate?: Date
): Promise<BackupableTripSheet[]> {
  const items = await listOneDriveProcessedTripSheets();
  const results: BackupableTripSheet[] = [];

  for (const item of items) {
    const processedAt = new Date(item.lastModifiedDateTime);
    if (beforeDate && processedAt >= beforeDate) continue;

    results.push({
      filename: item.name,
      sizeBytes: item.size,
      processedAt: processedAt.toISOString(),
    });
  }

  results.sort(
    (a, b) =>
      new Date(a.processedAt).getTime() - new Date(b.processedAt).getTime()
  );

  return results;
}

/**
 * Get a combined summary of all backupable items.
 */
export async function getBackupSummary(
  beforeDate?: Date
): Promise<BackupSummary> {
  const [invoices, tripSheets] = await Promise.all([
    getBackupableInvoices(beforeDate),
    getBackupableTripSheets(beforeDate),
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
  invoiceFilenames: string[],
  tripSheetFilenames: string[]
): Promise<Buffer> {
  const zip = new JSZip();
  const datestamp = new Date().toISOString().slice(0, 10);
  const prefix = `backup-${datestamp}`;

  // ── Signed invoices ──────────────────────────────────────────────
  if (invoiceFilenames.length > 0) {
    const onedrive = await getOneDriveInvoiceSource();
    if (onedrive) {
      const items = await listOneDriveSignedInvoices();
      for (const filename of invoiceFilenames) {
        const item = items.find((i) => i.name === filename);
        if (!item) continue;
        try {
          const fileData = await downloadFileById(item.id);
          zip.file(`${prefix}/signed-invoices/${filename}`, fileData);
        } catch {
          // skip files we can't download
        }
      }
    } else {
      const folderPath = await getInvoiceFolderPath();
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

  // ── Completed trip sheet files (from processed/ folder) ──────────
  if (tripSheetFilenames.length > 0) {
    const onedrive = await getOneDriveSource();
    if (onedrive) {
      const items = await listOneDriveProcessedTripSheets();
      for (const filename of tripSheetFilenames) {
        const item = items.find((i) => i.name === filename);
        if (!item) continue;
        try {
          const fileData = await downloadFileById(item.id);
          zip.file(`${prefix}/trip-sheets/${filename}`, fileData);
        } catch {
          // skip files we can't download
        }
      }
    } else {
      const folderPath = await getTripSheetFolderPath();
      if (folderPath) {
        const processedFolder = path.join(folderPath, "processed");
        for (const filename of tripSheetFilenames) {
          const filePath = path.join(processedFolder, filename);
          // Security: prevent directory traversal
          const resolved = path.resolve(filePath);
          const resolvedFolder = path.resolve(processedFolder);
          if (!resolved.startsWith(resolvedFolder)) continue;

          if (fs.existsSync(resolved)) {
            const fileData = fs.readFileSync(resolved);
            zip.file(`${prefix}/trip-sheets/${filename}`, fileData);
          }
        }
      }
    }
  }

  // ── Manifest ─────────────────────────────────────────────────────
  const manifest = {
    createdAt: new Date().toISOString(),
    version: "1.0",
    contents: {
      signedInvoices: invoiceFilenames.length,
      tripSheets: tripSheetFilenames.length,
    },
    invoiceFilenames,
    tripSheetFilenames,
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
  filenames: string[]
): Promise<{ deleted: number; failed: string[] }> {
  const folderPath = await getInvoiceFolderPath();
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
 * Delete completed trip sheet files from the processed/ folder.
 * Removes from OneDrive if configured, otherwise from the local filesystem.
 */
export async function purgeBackedUpTripSheets(
  tripSheetFilenames: string[]
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];

  const onedrive = await getOneDriveSource();
  if (onedrive) {
    const items = await listOneDriveProcessedTripSheets();
    for (const filename of tripSheetFilenames) {
      const item = items.find((i) => i.name === filename);
      if (!item) {
        // Already gone — count as success
        deleted++;
        continue;
      }
      try {
        await deleteFileById(item.id);
        deleted++;
      } catch {
        failed.push(filename);
      }
    }
    return { deleted, failed };
  }

  const folderPath = await getTripSheetFolderPath();
  if (!folderPath) {
    return { deleted: 0, failed: tripSheetFilenames };
  }

  const processedFolder = path.join(folderPath, "processed");
  for (const filename of tripSheetFilenames) {
    const filePath = path.join(processedFolder, filename);
    const resolved = path.resolve(filePath);
    const resolvedFolder = path.resolve(processedFolder);

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
