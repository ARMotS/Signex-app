/**
 * Per-scope app configuration — PostgreSQL via Prisma (key-value store).
 * Runtime changes without server restart.
 *
 * Every setting here belongs to ONE admin, not to the installation: the invoice
 * folder, the trip sheet folder and the signature position are all things one
 * ADMIN configures for their own operation. Reads and writes go through the
 * scoped client, so an ADMIN can neither see nor overwrite another's settings.
 */

import fs from "fs";
import path from "path";
import { scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import { detectCloudProvider, type CloudProvider } from "./cloud-detect";

export interface SignaturePosition {
  xPercent: number;      // 0-100, left edge of signature box as % of page width
  yPercent: number;      // 0-100, bottom edge of signature box as % of page height
  widthPercent: number;  // signature max width as % of page width
  page: "first" | "last";
}

export const DEFAULT_SIGNATURE_POSITION: SignaturePosition = {
  xPercent: 65,
  yPercent: 7,
  widthPercent: 30,
  page: "last",
};

export interface SignexConfig {
  invoiceFolderPath: string;
  invoiceFolderType: CloudProvider;
  tripSheetFolderPath: string;
  tripSheetFolderType: CloudProvider;
  signaturePosition: SignaturePosition;
}

const DEFAULT_CONFIG: SignexConfig = {
  invoiceFolderPath: "",
  invoiceFolderType: "local",
  tripSheetFolderPath: "",
  tripSheetFolderType: "local",
  signaturePosition: DEFAULT_SIGNATURE_POSITION,
};

/**
 * Read one scope's config from the database.
 * Falls back to defaults if keys don't exist for that scope.
 */
export async function readConfig(tenantId: string): Promise<SignexConfig> {
  try {
    const rows = await scopedPrisma(tenantId).appConfig.findMany();
    const config = { ...DEFAULT_CONFIG };

    for (const row of rows) {
      if (row.key === "invoiceFolderPath") {
        config.invoiceFolderPath = row.value;
        // Auto-detect cloud provider from path
        config.invoiceFolderType = detectCloudProvider(row.value);
      } else if (row.key === "tripSheetFolderPath") {
        config.tripSheetFolderPath = row.value;
        config.tripSheetFolderType = detectCloudProvider(row.value);
      } else if (row.key === "signaturePosition") {
        try {
          config.signaturePosition = JSON.parse(row.value);
        } catch {
          // keep default if JSON is invalid
        }
      }
    }

    return config;
  } catch (err) {
    console.error("Failed to read config:", err);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Write updated config for one scope. Merges with that scope's existing config.
 */
export async function writeConfig(
  tenantId: string,
  updates: Partial<SignexConfig>
): Promise<SignexConfig> {
  const db = scopedPrisma(tenantId);
  const current = await readConfig(tenantId);
  const merged = { ...current, ...updates };

  // Upsert each key-value pair, serializing objects to JSON.
  // The AppConfig primary key is [tenantId, key] — the scoped client injects
  // tenantId into both the where clause and the create payload.
  const upserts = Object.entries(merged).map(([key, value]) => {
    const serialized =
      typeof value === "object" ? JSON.stringify(value) : String(value);
    return db.appConfig.upsert({
      where: { tenantId_key: { tenantId, key } },
      update: { value: serialized },
      create: { key, value: serialized },
    });
  });

  await Promise.all(upserts);

  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "config",
    details: JSON.stringify(Object.keys(updates)),
    tenantId,
  });

  return merged;
}

/**
 * Validate that a folder path exists and is accessible.
 * @param folderType - "invoices" counts PDFs, "tripsheets" counts CSV/Excel files
 */
export function validateFolderPath(folderPath: string, folderType: "invoices" | "tripsheets" = "invoices"): {
  valid: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  fileCount: number;
  pdfCount: number;
  matchedFileCount: number;
  matchedFileLabel: string;
  error?: string;
} {
  const result = {
    valid: false,
    exists: false,
    readable: false,
    writable: false,
    fileCount: 0,
    pdfCount: 0,
    matchedFileCount: 0,
    matchedFileLabel: folderType === "tripsheets" ? "Trip Sheets" : "PDFs",
    error: undefined as string | undefined,
  };

  if (!folderPath || folderPath.trim() === "") {
    result.error = "Folder path is empty";
    return result;
  }

  try {
    result.exists = fs.existsSync(folderPath);
    if (!result.exists) {
      result.error = "Folder does not exist";
      return result;
    }

    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      result.error = "Path is not a directory";
      return result;
    }

    // Check read access
    try {
      const files = fs.readdirSync(folderPath);
      result.readable = true;
      result.fileCount = files.length;

      if (folderType === "tripsheets") {
        // Count CSV/Excel files for trip sheet folders
        const tripSheetExts = [".csv", ".xlsx", ".xls"];
        result.matchedFileCount = files.filter((f) =>
          tripSheetExts.includes(f.toLowerCase().slice(f.lastIndexOf(".")))
        ).length;
      } else {
        // Count PDFs for invoice folders
        result.matchedFileCount = files.filter((f) =>
          f.toLowerCase().endsWith(".pdf")
        ).length;
      }
      result.pdfCount = result.matchedFileCount; // backward compat
    } catch {
      result.error = "Cannot read directory — check permissions";
      return result;
    }

    // Check write access
    try {
      const testFile = path.join(folderPath, ".signex-write-test");
      fs.writeFileSync(testFile, "test");
      fs.unlinkSync(testFile);
      result.writable = true;
    } catch {
      result.writable = false;
      // Not a fatal error — read-only is okay for viewing
    }

    result.valid = true;
  } catch (err) {
    result.error = `Cannot access path: ${err instanceof Error ? err.message : String(err)}`;
  }

  return result;
}
