import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

interface FolderEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  pdfCount?: number;
}

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const searchParams = request.nextUrl.searchParams;
  let targetPath = searchParams.get("path") || "";
  const folderType = searchParams.get("type") === "tripsheets" ? "tripsheets" : "invoices";

  // File extensions to count based on folder type
  const countExtensions = folderType === "tripsheets"
    ? [".csv", ".xlsx", ".xls"]
    : [".pdf"];
  const fileLabel = folderType === "tripsheets" ? "files" : "PDFs";

  try {
    // If no path, return root locations (drives on Windows, / on Unix)
    if (!targetPath || targetPath === "") {
      const roots = getRootLocations();
      return NextResponse.json({
        current: "",
        parent: null,
        entries: roots,
        breadcrumbs: [],
      });
    }

    // Normalize the path
    targetPath = path.resolve(targetPath);

    if (!fs.existsSync(targetPath)) {
      return NextResponse.json(
        { error: "Path does not exist" },
        { status: 404 }
      );
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return NextResponse.json(
        { error: "Path is not a directory" },
        { status: 400 }
      );
    }

    // List directory contents
    let items: string[];
    try {
      items = fs.readdirSync(targetPath);
    } catch {
      return NextResponse.json(
        { error: "Cannot read directory — check permissions" },
        { status: 403 }
      );
    }

    const entries: FolderEntry[] = [];

    for (const item of items) {
      // Skip hidden files/folders and system folders
      if (item.startsWith(".") || item.startsWith("$")) continue;

      const fullPath = path.join(targetPath, item);
      try {
        const itemStat = fs.statSync(fullPath);
        if (itemStat.isDirectory()) {
          // Count matching files in this folder (non-recursive, quick peek)
          let pdfCount = 0;
          try {
            const children = fs.readdirSync(fullPath);
            pdfCount = children.filter((c) => {
              const ext = c.toLowerCase().slice(c.lastIndexOf("."));
              return countExtensions.includes(ext);
            }).length;
          } catch {
            // Can't read — that's okay
          }

          entries.push({
            name: item,
            path: fullPath,
            isDirectory: true,
            pdfCount,
          });
        }
      } catch {
        // Skip inaccessible items
      }
    }

    // Sort: folders with PDFs first, then alphabetical
    entries.sort((a, b) => {
      if ((a.pdfCount ?? 0) > 0 && (b.pdfCount ?? 0) === 0) return -1;
      if ((a.pdfCount ?? 0) === 0 && (b.pdfCount ?? 0) > 0) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    // Count matching files in current folder
    let currentPdfCount = 0;
    try {
      currentPdfCount = items.filter((i) => {
        const ext = i.toLowerCase().slice(i.lastIndexOf("."));
        return countExtensions.includes(ext);
      }).length;
    } catch {
      // ignore
    }

    // Build breadcrumbs
    const breadcrumbs = buildBreadcrumbs(targetPath);

    // Get parent path
    const parentPath = path.dirname(targetPath);
    const parent = parentPath !== targetPath ? parentPath : null;

    return NextResponse.json({
      current: targetPath,
      parent,
      entries,
      breadcrumbs,
      currentPdfCount,
      fileLabel,
    });
  } catch (error) {
    console.error("Browse error:", error);
    return NextResponse.json(
      { error: "Failed to browse directory" },
      { status: 500 }
    );
  }
});

function getRootLocations(): FolderEntry[] {
  const entries: FolderEntry[] = [];

  if (process.platform === "win32") {
    // Windows: list available drives
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${letter}:\\`;
      try {
        if (fs.existsSync(drive)) {
          fs.readdirSync(drive); // Test read access
          entries.push({
            name: `${letter}:  Drive`,
            path: drive,
            isDirectory: true,
          });
        }
      } catch {
        // Drive exists but not accessible
      }
    }
  } else {
    // Unix: show common locations
    entries.push({ name: "/", path: "/", isDirectory: true });
  }

  // Add common locations
  const home = os.homedir();
  if (fs.existsSync(home)) {
    entries.push({
      name: "Home",
      path: home,
      isDirectory: true,
    });
  }

  const desktop = path.join(home, "Desktop");
  if (fs.existsSync(desktop)) {
    entries.push({
      name: "Desktop",
      path: desktop,
      isDirectory: true,
    });
  }

  const documents = path.join(home, "Documents");
  if (fs.existsSync(documents)) {
    entries.push({
      name: "Documents",
      path: documents,
      isDirectory: true,
    });
  }

  const downloads = path.join(home, "Downloads");
  if (fs.existsSync(downloads)) {
    entries.push({
      name: "Downloads",
      path: downloads,
      isDirectory: true,
    });
  }

  // Add project default
  const projectInvoices = path.join(process.cwd(), "invoices");
  entries.push({
    name: "Default (./invoices)",
    path: projectInvoices,
    isDirectory: true,
  });

  return entries;
}

function buildBreadcrumbs(
  fullPath: string
): { name: string; path: string }[] {
  const parts = fullPath.split(path.sep).filter(Boolean);
  const crumbs: { name: string; path: string }[] = [];

  // Root
  if (process.platform === "win32") {
    if (parts.length > 0) {
      crumbs.push({ name: parts[0], path: parts[0] + "\\" });
      for (let i = 1; i < parts.length; i++) {
        crumbs.push({
          name: parts[i],
          path: parts.slice(0, i + 1).join("\\") + "\\",
        });
      }
    }
  } else {
    crumbs.push({ name: "/", path: "/" });
    for (let i = 0; i < parts.length; i++) {
      crumbs.push({
        name: parts[i],
        path: "/" + parts.slice(0, i + 1).join("/"),
      });
    }
  }

  return crumbs;
}
