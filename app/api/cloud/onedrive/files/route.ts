import { NextRequest, NextResponse } from "next/server";
import {
  listOneDriveTripSheetFiles,
  downloadFileById,
  assertItemInConfiguredFolder,
} from "@/lib/microsoft-graph";
import { getScope, requireOffice } from "@/lib/tenant";
import { importStates } from "@/lib/trip-sheet-folder";
import { withAuth } from "@/lib/api-handler";

/**
 * GET /api/cloud/onedrive/files
 * Lists trip sheet files (CSV/Excel) in THIS scope's configured OneDrive folder.
 * Checks import status against this scope's ImportedFile rows.
 */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireOffice(ctx);

  const items = await listOneDriveTripSheetFiles(ctx.tenantId);

  // Which files this ADMIN has already imported. Import state is per-scope, so
  // another ADMIN importing the same filename does not mark it consumed here.
  // Same rule as the trip sheet folder listing: a file whose run was deleted
  // reads as removed, not imported (see importStates).
  const states = await importStates(ctx.tenantId, items.map((i) => i.name));

  const files = items.map((item) => {
    const state = states.get(item.name);
    return {
      id: item.id,
      filename: item.name,
      sizeBytes: item.size,
      lastModified: item.lastModifiedDateTime,
      extension: item.name.slice(item.name.lastIndexOf(".") + 1).toLowerCase(),
      imported: state?.imported ?? false,
      tripRemoved: state?.tripRemoved ?? false,
      importedAt: state?.importedAt,
      importStatus: state?.importStatus,
    };
  });

  // Sort: new files first, then by last modified
  files.sort((a, b) => {
    if (a.imported !== b.imported) return a.imported ? 1 : -1;
    return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
  });

  return NextResponse.json({
    totalFiles: files.length,
    newFiles: files.filter((f) => !f.imported && !f.tripRemoved).length,
    files,
  });
});

/**
 * POST /api/cloud/onedrive/files
 * Download a file from OneDrive by item ID and return its contents as base64.
 * Body: { fileId: string, filename: string }
 *
 * `fileId` is client-supplied, so two things constrain it: the Graph call uses
 * only this scope's token (another ADMIN's item id 404s at Microsoft), and the
 * item must sit inside a folder this ADMIN configured in Signex.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const { fileId, filename } = await request.json();

  if (!fileId || !filename) {
    return NextResponse.json(
      { error: "fileId and filename are required" },
      { status: 400 }
    );
  }

  try {
    await assertItemInConfiguredFolder(ctx.tenantId, fileId);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const buffer = await downloadFileById(ctx.tenantId, fileId);
  const base64 = buffer.toString("base64");

  return NextResponse.json({
    filename,
    base64,
    sizeBytes: buffer.length,
  });
});
