/**
 * Trip sheet folder operations — reads CSV/Excel files from a configured
 * cloud-synced (or local) folder, OR from OneDrive via Graph API.
 *
 * Features:
 *   - List available trip sheet files in the folder
 *   - Track which files have already been imported (via DB)
 *   - Import a file: read → parse → return preview data
 *   - Move processed files to a processed/ subfolder
 *
 * Priority for folder source:
 *   1. OneDrive Graph API (if cloud account connected with folder configured)
 *   2. Runtime config in database (AppConfig table) — local filesystem path
 *   3. TRIP_SHEET_FOLDER_PATH environment variable
 *   4. null (no folder configured)
 */

import fs from "fs";
import path from "path";
import { prisma } from "./db";
import { readConfig } from "./config";
import { detectCloudProvider, type CloudProvider } from "./cloud-detect";
import {
  getCloudAccountStatus,
  listOneDriveTripSheetFiles,
  downloadFileById,
} from "./microsoft-graph";

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
 * Check if OneDrive Graph API should be used as the file source.
 * Returns the cloud account status if connected with a folder configured.
 */
export async function getOneDriveSource(): Promise<{
  connected: boolean;
  folderPath?: string;
  folderItemId?: string;
} | null> {
  try {
    const status = await getCloudAccountStatus();
    if (status?.connected && status.folderItemId) {
      return {
        connected: true,
        folderPath: status.folderPath ?? undefined,
        folderItemId: status.folderItemId,
      };
    }
  } catch {
    // Graph API not configured or unavailable — fall through to local
  }
  return null;
}

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
 * Uses OneDrive Graph API if connected, otherwise falls back to local filesystem.
 * Checks DB to mark which files have already been imported.
 */
export async function listTripSheetFiles(): Promise<TripSheetFolderInfo> {
  // Try OneDrive Graph API first
  const onedrive = await getOneDriveSource();
  if (onedrive) {
    return listTripSheetFilesFromOneDrive(onedrive.folderPath || "");
  }

  // Fall back to local filesystem
  return listTripSheetFilesFromLocal();
}

async function listTripSheetFilesFromOneDrive(
  folderPath: string
): Promise<TripSheetFolderInfo> {
  try {
    const items = await listOneDriveTripSheetFiles();

    const filenames = items.map((i) => i.name);
    const importRecords = await prisma.importedFile.findMany({
      where: { filename: { in: filenames } },
    });
    const importMap = new Map(importRecords.map((r) => [r.filename, r]));

    const files: TripSheetFile[] = items.map((item) => {
      const ext = item.name.slice(item.name.lastIndexOf(".") + 1).toLowerCase();
      const importRecord = importMap.get(item.name);

      return {
        filename: item.name,
        fullPath: item.id, // Store OneDrive item ID as fullPath for download
        sizeBytes: item.size,
        lastModified: item.lastModifiedDateTime,
        extension: ext,
        imported: !!importRecord,
        importedAt: importRecord?.importedAt.toISOString(),
        importStatus: importRecord?.status,
      };
    });

    files.sort((a, b) => {
      if (a.imported !== b.imported) return a.imported ? 1 : -1;
      return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
    });

    const newFiles = files.filter((f) => !f.imported).length;

    return {
      path: folderPath,
      accessible: true,
      provider: "onedrive",
      totalFiles: files.length,
      newFiles,
      files,
    };
  } catch (err) {
    console.error("Failed to list OneDrive trip sheet files:", err);
    return {
      path: folderPath,
      accessible: false,
      provider: "onedrive",
      totalFiles: 0,
      newFiles: 0,
      files: [],
    };
  }
}

async function listTripSheetFilesFromLocal(): Promise<TripSheetFolderInfo> {
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
 * Read a trip sheet file as a Buffer.
 * If OneDrive is connected, downloads via Graph API using the item ID stored in fullPath.
 * Otherwise reads from local filesystem.
 *
 * @param filename - The file's display name
 * @param fileId - Optional OneDrive item ID (used when source is OneDrive)
 */
export async function readTripSheetFile(
  filename: string,
  fileId?: string
): Promise<{ buffer: Buffer; filename: string } | null> {
  // If a fileId is provided, download from OneDrive
  if (fileId) {
    try {
      const buffer = await downloadFileById(fileId);
      return { buffer, filename };
    } catch (err) {
      console.error(`Failed to download ${filename} from OneDrive:`, err);
      return null;
    }
  }

  // Check if OneDrive is connected and try to find the file there
  const onedrive = await getOneDriveSource();
  if (onedrive) {
    try {
      const items = await listOneDriveTripSheetFiles();
      const match = items.find((i) => i.name === filename);
      if (match) {
        const buffer = await downloadFileById(match.id);
        return { buffer, filename };
      }
    } catch (err) {
      console.error(`Failed to download ${filename} from OneDrive:`, err);
    }
    return null;
  }

  // Fall back to local filesystem
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
