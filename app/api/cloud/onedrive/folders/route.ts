import { NextRequest, NextResponse } from "next/server";
import {
  listRootFolders,
  listFolderById,
  setOneDriveFolder,
} from "@/lib/microsoft-graph";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * GET /api/cloud/onedrive/folders?parentId=<id>
 * Browse OneDrive folders. Without parentId, returns root folders.
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);
  const parentId = searchParams.get("parentId");

  const items = parentId
    ? await listFolderById(parentId)
    : await listRootFolders();

  // Return only folders for the folder picker
  const folders = items.filter((item) => item.folder);

  return NextResponse.json({ folders });
});

/**
 * POST /api/cloud/onedrive/folders
 * Set the selected OneDrive folder as the trip sheet source.
 * Body: { folderPath: string, folderItemId: string }
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { folderPath, folderItemId } = await request.json();

  if (!folderPath || !folderItemId) {
    return NextResponse.json(
      { error: "folderPath and folderItemId are required" },
      { status: 400 }
    );
  }

  await setOneDriveFolder(folderPath, folderItemId);
  return NextResponse.json({ success: true, folderPath, folderItemId });
});
