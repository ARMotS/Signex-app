/**
 * Cloud provider detection utilities.
 *
 * Detects whether a given folder path belongs to a OneDrive or Google Drive
 * sync folder. Also discovers common cloud sync root paths on Windows.
 *
 * Supported providers:
 *   - OneDrive (personal & business)
 *   - Google Drive (Drive for Desktop)
 */

import fs from "fs";
import path from "path";
import os from "os";

export type CloudProvider = "onedrive" | "gdrive" | "local";

export interface CloudFolderInfo {
  /** Detected provider */
  provider: CloudProvider;
  /** Human-readable label */
  label: string;
  /** Provider icon emoji */
  icon: string;
  /** Whether the sync root exists on this machine */
  synced: boolean;
}

export interface CloudSyncRoot {
  provider: CloudProvider;
  label: string;
  icon: string;
  path: string;
  exists: boolean;
}

// ─── Path Patterns ────────────────────────────────────────────────────────

const ONEDRIVE_PATTERNS = [
  /[/\\]onedrive[/\\]/i,
  /[/\\]onedrive\s*-\s*/i, // "OneDrive - Company Name"
  /[/\\]onedrive$/i,
];

const GDRIVE_PATTERNS = [
  /[/\\]google\s*drive[/\\]/i,
  /[/\\]my\s*drive[/\\]/i,
  /[/\\]google\s*drive$/i,
  /^[A-Z]:[/\\]my\s*drive/i, // Mapped drive like G:\My Drive
];

/**
 * Detect the cloud provider from a folder path.
 */
export function detectCloudProvider(folderPath: string): CloudProvider {
  if (!folderPath) return "local";
  const normalized = folderPath.replace(/\\/g, "/");

  for (const pattern of ONEDRIVE_PATTERNS) {
    if (pattern.test(normalized)) return "onedrive";
  }

  for (const pattern of GDRIVE_PATTERNS) {
    if (pattern.test(normalized)) return "gdrive";
  }

  return "local";
}

/**
 * Get display information about a cloud folder path.
 */
export function getCloudFolderInfo(folderPath: string): CloudFolderInfo {
  const provider = detectCloudProvider(folderPath);
  let exists = false;

  try {
    exists = fs.existsSync(folderPath);
  } catch {
    // ignore access errors
  }

  switch (provider) {
    case "onedrive":
      return {
        provider,
        label: "OneDrive",
        icon: "☁️",
        synced: exists,
      };
    case "gdrive":
      return {
        provider,
        label: "Google Drive",
        icon: "📁",
        synced: exists,
      };
    default:
      return {
        provider: "local",
        label: "Local Folder",
        icon: "💻",
        synced: exists,
      };
  }
}

/**
 * Scan for common cloud sync folder roots on this machine.
 * Returns all known locations with their existence status.
 */
export function getCloudSyncRoots(): CloudSyncRoot[] {
  const roots: CloudSyncRoot[] = [];
  const homeDir = os.homedir();

  // ─── OneDrive locations ─────────────────────────────────────────────
  const oneDrivePaths = [
    path.join(homeDir, "OneDrive"),
    path.join(homeDir, "OneDrive - Personal"),
  ];

  // Check env vars for OneDrive paths (Windows sets these)
  const envOneDrive = process.env.OneDrive || process.env.OneDriveConsumer;
  if (envOneDrive && !oneDrivePaths.includes(envOneDrive)) {
    oneDrivePaths.unshift(envOneDrive);
  }
  const envOneDriveBiz = process.env.OneDriveCommercial;
  if (envOneDriveBiz) {
    oneDrivePaths.push(envOneDriveBiz);
  }

  // Also scan for "OneDrive - <Company>" folders in home directory
  try {
    const homeDirEntries = fs.readdirSync(homeDir);
    for (const entry of homeDirEntries) {
      if (/^onedrive\s*-\s*/i.test(entry)) {
        const fullPath = path.join(homeDir, entry);
        if (!oneDrivePaths.includes(fullPath)) {
          oneDrivePaths.push(fullPath);
        }
      }
    }
  } catch {
    // ignore
  }

  for (const p of oneDrivePaths) {
    let exists = false;
    try {
      exists = fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      // ignore
    }
    if (exists) {
      roots.push({
        provider: "onedrive",
        label: `OneDrive (${path.basename(p)})`,
        icon: "☁️",
        path: p,
        exists: true,
      });
    }
  }

  // ─── Google Drive locations ─────────────────────────────────────────
  const gdrivePaths: string[] = [];

  // Check common mapped drive letters (G: through L:)
  for (const letter of ["G", "H", "I", "J", "K", "L"]) {
    gdrivePaths.push(`${letter}:\\My Drive`);
    gdrivePaths.push(`${letter}:\\`);
  }

  // Standard install paths
  gdrivePaths.push(path.join(homeDir, "Google Drive"));
  gdrivePaths.push(path.join(homeDir, "My Drive"));

  for (const p of gdrivePaths) {
    let exists = false;
    try {
      exists = fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      // ignore
    }
    if (exists) {
      // Avoid adding bare drive letters unless they have a "My Drive" marker
      if (/^[A-Z]:\\$/.test(p)) {
        // Check if this drive root has a Google Drive marker
        try {
          const hasMyDrive = fs.existsSync(path.join(p, "My Drive"));
          if (!hasMyDrive) continue;
        } catch {
          continue;
        }
      }

      roots.push({
        provider: "gdrive",
        label: `Google Drive (${path.basename(p) || p.slice(0, 2)})`,
        icon: "📁",
        path: p,
        exists: true,
      });
    }
  }

  return roots;
}
