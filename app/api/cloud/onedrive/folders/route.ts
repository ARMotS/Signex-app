import { NextRequest, NextResponse } from "next/server";
import {
  listRootFolders,
  listFolderById,
  setOneDriveFolder,
  setOneDriveInvoiceFolder,
} from "@/lib/microsoft-graph";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * GET /api/cloud/onedrive/folders?parentId=<id>
 * Browse OneDrive folders. Without parentId, returns root folders.
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);
  const parentId = searchParams.get("parentId");

  // parentId is client-supplied but resolved with THIS scope's token against
  // THIS scope's drive, so another ADMIN's folder id yields a Graph 404.
  const items = parentId
    ? await listFolderById(ctx.tenantId, parentId)
    : await listRootFolders(ctx.tenantId);

  // Return only folders for the folder picker
  const folders = items.filter((item) => item.folder);

  return NextResponse.json({ folders });
});

/**
 * POST /api/cloud/onedrive/folders
 * Set the selected OneDrive folder as the trip sheet or invoice source.
 * Body: { folderPath: string, folderItemId: string, target?: "tripsheets" | "invoices" }
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { folderPath, folderItemId, target } = await request.json();

  if (!folderPath || !folderItemId) {
    return NextResponse.json(
      { error: "folderPath and folderItemId are required" },
      { status: 400 }
    );
  }

  if (target === "invoices") {
    await setOneDriveInvoiceFolder(ctx.tenantId, folderPath, folderItemId);
  } else {
    await setOneDriveFolder(ctx.tenantId, folderPath, folderItemId);
  }

  return NextResponse.json({ success: true, folderPath, folderItemId, target: target || "tripsheets" });
});
