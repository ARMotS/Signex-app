import { NextRequest, NextResponse } from "next/server";
import {
  listOneDriveTripSheetFiles,
  downloadFileById,
} from "@/lib/microsoft-graph";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";

/**
 * GET /api/cloud/onedrive/files
 * Lists trip sheet files (CSV/Excel) in the configured OneDrive folder.
 * Checks import status against the DB.
 */
export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const items = await listOneDriveTripSheetFiles();

  // Check which files have already been imported
  const filenames = items.map((i) => i.name);
  const importRecords = await prisma.importedFile.findMany({
    where: { filename: { in: filenames } },
  });
  const importMap = new Map(importRecords.map((r) => [r.filename, r]));

  const files = items.map((item) => {
    const importRecord = importMap.get(item.name);
    return {
      id: item.id,
      filename: item.name,
      sizeBytes: item.size,
      lastModified: item.lastModifiedDateTime,
      extension: item.name.slice(item.name.lastIndexOf(".") + 1).toLowerCase(),
      imported: !!importRecord,
      importedAt: importRecord?.importedAt.toISOString(),
      importStatus: importRecord?.status,
    };
  });

  // Sort: new files first, then by last modified
  files.sort((a, b) => {
    if (a.imported !== b.imported) return a.imported ? 1 : -1;
    return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
  });

  return NextResponse.json({
    totalFiles: files.length,
    newFiles: files.filter((f) => !f.imported).length,
    files,
  });
});

/**
 * POST /api/cloud/onedrive/files
 * Download a file from OneDrive by item ID and return its contents as base64.
 * Body: { fileId: string, filename: string }
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { fileId, filename } = await request.json();

  if (!fileId || !filename) {
    return NextResponse.json(
      { error: "fileId and filename are required" },
      { status: 400 }
    );
  }

  const buffer = await downloadFileById(fileId);
  const base64 = buffer.toString("base64");

  return NextResponse.json({
    filename,
    base64,
    sizeBytes: buffer.length,
  });
});
