/**
 * Trip sheet folder operations — reads CSV/Excel files from a configured
 * cloud-synced (or local) folder.
 *
 * Features:
 *   - List available trip sheet files in the folder
 *   - Track which files have already been imported (via DB)
 *   - Import a file: read → parse → return preview data
 *   - Move processed files to a processed/ subfolder
 *
 * Priority for folder path:
 *   1. Runtime config in database (AppConfig table)
 *   2. TRIP_SHEET_FOLDER_PATH environment variable
 *   3. null (no folder configured)
 */

import fs from "fs";
import path from "path";
import { prisma } from "./db";
import { readConfig } from "./config";
import { detectCloudProvider, type CloudProvider } from "./cloud-detect";

export interface TripSheetFile {
  /** Filename (basename) */
  filename: string;
  /** Full file path */
  fullPath: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Last modified date as ISO string */
  lastModified: string;
  /** File extension (csv, xlsx, xls) */
  extension: string;
  /** Whether this file has already been imported */
  imported: boolean;
  /** When this file was imported (if applicable) */
  importedAt?: string;
  /** Import status */
  importStatus?: string;
}

export interface TripSheetFolderInfo {
  /** Configured folder path (empty string if not configured) */
  path: string;
  /** Whether the folder exists and is accessible */
  accessible: boolean;
  /** Detected cloud provider */
  provider: CloudProvider;
  /** Total trip sheet files found */
  totalFiles: number;
  /** Number of new (unimported) files */
  newFiles: number;
  /** Files in the folder */
  files: TripSheetFile[];
}

const TRIP_SHEET_EXTENSIONS = [".csv", ".xlsx", ".xls"];

/**
 * Get the configured trip sheet folder path.
 * Returns null if no folder is configured.
 */
export async function getTripSheetFolderPath(): Promise<string | null> {
  const config = await readConfig();
  if (config.tripSheetFolderPath && config.tripSheetFolderPath.trim() !== "") {
    return config.tripSheetFolderPath;
  }
  return process.env.TRIP_SHEET_FOLDER_PATH || null;
}

/**
 * List all trip sheet files in the configured folder.
 * Checks DB to mark which files have already been imported.
 */
export async function listTripSheetFiles(): Promise<TripSheetFolderInfo> {
  const folderPath = await getTripSheetFolderPath();

  if (!folderPath) {
    return {
      path: "",
      accessible: false,
      provider: "local",
      totalFiles: 0,
      newFiles: 0,
      files: [],
    };
  }

  const provider = detectCloudProvider(folderPath);

  // Check folder accessibility
  if (!fs.existsSync(folderPath)) {
    return {
      path: folderPath,
      accessible: false,
      provider,
      totalFiles: 0,
      newFiles: 0,
      files: [],
    };
  }

  try {
    const entries = fs.readdirSync(folderPath);
    const tripFiles = entries.filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return TRIP_SHEET_EXTENSIONS.includes(ext);
    });

    // Get import records from DB
    const importRecords = await prisma.importedFile.findMany({
      where: {
        filename: { in: tripFiles },
      },
    });
    const importMap = new Map(
      importRecords.map((r) => [r.filename, r])
    );

    const files: TripSheetFile[] = tripFiles.map((filename) => {
      const fullPath = path.join(folderPath, filename);
      const stats = fs.statSync(fullPath);
      const ext = path.extname(filename).toLowerCase().slice(1);
      const importRecord = importMap.get(filename);

      return {
        filename,
        fullPath,
        sizeBytes: stats.size,
        lastModified: stats.mtime.toISOString(),
        extension: ext,
        imported: !!importRecord,
        importedAt: importRecord?.importedAt.toISOString(),
        importStatus: importRecord?.status,
      };
    });

    // Sort: new files first, then by last modified (newest first)
    files.sort((a, b) => {
      if (a.imported !== b.imported) return a.imported ? 1 : -1;
      return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
    });

    const newFiles = files.filter((f) => !f.imported).length;

    return {
      path: folderPath,
      accessible: true,
      provider,
      totalFiles: files.length,
      newFiles,
      files,
    };
  } catch (err) {
    console.error("Failed to list trip sheet files:", err);
    return {
      path: folderPath,
      accessible: false,
      provider,
      totalFiles: 0,
      newFiles: 0,
      files: [],
    };
  }
}

/**
 * Read a trip sheet file from the configured folder as a Buffer.
 * Returns { buffer, filename } or null if not found.
 */
export async function readTripSheetFile(
  filename: string
): Promise<{ buffer: Buffer; filename: string } | null> {
  const folderPath = await getTripSheetFolderPath();
  if (!folderPath) return null;

  const filePath = path.join(folderPath, filename);

  // Security: prevent directory traversal
  const resolved = path.resolve(filePath);
  const resolvedFolder = path.resolve(folderPath);
  if (!resolved.startsWith(resolvedFolder)) {
    throw new Error("Invalid filename — directory traversal detected");
  }

  if (!fs.existsSync(resolved)) return null;

  return {
    buffer: fs.readFileSync(resolved),
    filename,
  };
}

/**
 * Mark a file as imported in the database.
 */
export async function markFileImported(
  filename: string,
  tripSheetId: string | null,
  status: string = "imported"
): Promise<void> {
  const folderPath = (await getTripSheetFolderPath()) || "";

  await prisma.importedFile.upsert({
    where: { filename },
    update: {
      status,
      tripSheetId,
      importedAt: new Date(),
    },
    create: {
      filename,
      folderPath,
      status,
      tripSheetId,
    },
  });
}

/**
 * Move a processed file to the processed/ subfolder.
 * Creates the subfolder if it doesn't exist.
 * Returns the new path, or null if the move failed.
 */
export async function moveToProcessed(filename: string): Promise<string | null> {
  const folderPath = await getTripSheetFolderPath();
  if (!folderPath) return null;

  const sourcePath = path.join(folderPath, filename);
  const processedDir = path.join(folderPath, "processed");
  const destPath = path.join(processedDir, filename);

  // Security: prevent directory traversal
  const resolvedSource = path.resolve(sourcePath);
  const resolvedFolder = path.resolve(folderPath);
  if (!resolvedSource.startsWith(resolvedFolder)) {
    throw new Error("Invalid filename — directory traversal detected");
  }

  try {
    if (!fs.existsSync(processedDir)) {
      fs.mkdirSync(processedDir, { recursive: true });
    }

    // If a file with the same name already exists in processed/, add a timestamp
    let finalDest = destPath;
    if (fs.existsSync(destPath)) {
      const ext = path.extname(filename);
      const base = path.basename(filename, ext);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      finalDest = path.join(processedDir, `${base}_${timestamp}${ext}`);
    }

    fs.renameSync(resolvedSource, finalDest);
    return finalDest;
  } catch (err) {
    console.error("Failed to move file to processed:", err);
    return null;
  }
}

/**
 * Save an uploaded file buffer to the trip sheet folder.
 * Ensures the file exists on disk so moveToProcessed can find it later.
 * Returns the full path, or null if no folder is configured.
 */
export async function saveUploadedFile(
  filename: string,
  buffer: Buffer
): Promise<string | null> {
  const folderPath = await getTripSheetFolderPath();
  if (!folderPath) return null;

  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }

  const destPath = path.join(folderPath, filename);

  // Don't overwrite if file already exists (e.g. imported from cloud folder)
  if (!fs.existsSync(destPath)) {
    fs.writeFileSync(destPath, buffer);
  }

  return destPath;
}

/**
 * Delete a single trip sheet file from the configured folder.
 * Also removes the corresponding ImportedFile DB record if it exists.
 */
export async function deleteTripSheetFile(
  filename: string
): Promise<{ success: boolean; error?: string }> {
  const folderPath = await getTripSheetFolderPath();
  if (!folderPath) {
    return { success: false, error: "No trip sheet folder configured" };
  }

  const filePath = path.join(folderPath, filename);

  // Security: prevent directory traversal
  const resolved = path.resolve(filePath);
  const resolvedFolder = path.resolve(folderPath);
  if (!resolved.startsWith(resolvedFolder)) {
    return { success: false, error: "Invalid filename — directory traversal detected" };
  }

  try {
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }

    // Also clean up the import record from DB
    try {
      await prisma.importedFile.deleteMany({ where: { filename } });
    } catch {
      // Ignore DB cleanup errors — file is already deleted
    }

    return { success: true };
  } catch (err) {
    console.error(`Failed to delete trip sheet file ${filename}:`, err);
    return { success: false, error: `Failed to delete ${filename}` };
  }
}

/**
 * Delete multiple trip sheet files from the configured folder.
 */
export async function deleteTripSheetFiles(
  filenames: string[]
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];

  for (const filename of filenames) {
    const result = await deleteTripSheetFile(filename);
    if (result.success) {
      deleted++;
    } else {
      failed.push(filename);
    }
  }

  return { deleted, failed };
}

export interface TripSheetDuplicateGroup {
  /** Normalized base name shared by duplicates */
  baseName: string;
  /** Filenames in this duplicate group */
  filenames: string[];
}

/**
 * Find duplicate trip sheet files in the configured folder.
 * Detects by normalizing filenames (strip copy patterns, case-insensitive)
 * and grouping files with the same effective name.
 */
export async function findDuplicateTripSheetFiles(): Promise<TripSheetDuplicateGroup[]> {
  const folderPath = await getTripSheetFolderPath();
  if (!folderPath || !fs.existsSync(folderPath)) return [];

  const entries = fs.readdirSync(folderPath);
  const tripFiles = entries.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return TRIP_SHEET_EXTENSIONS.includes(ext);
  });

  // Normalize: strip copy patterns, case-insensitive
  const normalize = (filename: string): string => {
    const ext = path.extname(filename).toLowerCase();
    const name = path.basename(filename, path.extname(filename));
    return (
      name
        .replace(/\s*\(\d+\)\s*$/i, "")     // " (1)", " (2)"
        .replace(/\s*-\s*copy\s*\d*$/i, "")  // " - Copy"
        .replace(/_copy\d*$/i, "")           // "_copy"
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase() + ext
    );
  };

  const groups = new Map<string, string[]>();
  for (const file of tripFiles) {
    const key = normalize(file);
    const existing = groups.get(key) || [];
    existing.push(file);
    groups.set(key, existing);
  }

  const duplicates: TripSheetDuplicateGroup[] = [];
  for (const [baseName, filenames] of groups) {
    if (filenames.length > 1) {
      duplicates.push({ baseName, filenames });
    }
  }

  return duplicates;
}
