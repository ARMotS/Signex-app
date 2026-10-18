import { NextRequest, NextResponse } from "next/server";
import {
  listRootFolders,
  listFolderById,
  setOneDriveFolder,
  setOneDriveInvoiceFolder,
  setOneDriveCollectionsFolder,
  setOneDriveCreditsFolder,
  getCloudAccountStatus,
} from "@/lib/microsoft-graph";
import { assertCollectionsFolderIsSibling, foldersOverlap } from "@/lib/collections";
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
 * Set the selected OneDrive folder as the trip sheet, invoice, collections or
 * credits source.
 * Body: { folderPath: string, folderItemId: string,
 *         target?: "tripsheets" | "invoices" | "collections" | "credits" }
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

  // Invoices and collections must not overlap, in either direction: both
  // listings are extension-based, so a nested pair turns every collection
  // document into a phantom invoice. Checked against whichever of the two is
  // already configured, so it does not matter which one the admin picks first.
  if (target === "invoices" || target === "collections") {
    const status = await getCloudAccountStatus(ctx.tenantId);
    const check =
      target === "collections"
        ? assertCollectionsFolderIsSibling(status?.invoiceFolderPath, folderPath)
        : assertCollectionsFolderIsSibling(folderPath, status?.collectionsFolderPath);

    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: 400 });
    }

    // Belt and braces for the case the two paths read as siblings but are the
    // same folder under different names — one item id cannot be two sources.
    const otherItemId =
      target === "collections" ? status?.invoiceFolderItemId : status?.collectionsFolderItemId;
    if (otherItemId && otherItemId === folderItemId) {
      return NextResponse.json(
        {
          error:
            "That is already the other folder. Invoices and collections need separate folders.",
        },
        { status: 400 }
      );
    }
  }

  // The credits folder is read the same extension-based way, so it overlaps
  // neither of the PDF folders — and neither of them may be moved over it.
  if (target === "credits" || target === "invoices" || target === "collections") {
    const status = await getCloudAccountStatus(ctx.tenantId);
    const others =
      target === "credits"
        ? [
            { label: "invoice", path: status?.invoiceFolderPath, id: status?.invoiceFolderItemId },
            { label: "collections", path: status?.collectionsFolderPath, id: status?.collectionsFolderItemId },
          ]
        : [{ label: "credits", path: status?.creditsFolderPath, id: status?.creditsFolderItemId }];
    const clash = others.find((o) => (o.id && o.id === folderItemId) || foldersOverlap(o.path, folderPath));
    if (clash) {
      return NextResponse.json(
        {
          error:
            target === "credits"
              ? `That folder overlaps the ${clash.label} folder. Credit notes need a folder of their own, alongside Invoices and Collections — not inside either, and not around them.`
              : "That folder overlaps the credits folder. Invoices, collections and credit notes each need a folder of their own, side by side.",
        },
        { status: 400 }
      );
    }
  }

  if (target === "credits") {
    await setOneDriveCreditsFolder(ctx.tenantId, folderPath, folderItemId);
  } else if (target === "invoices") {
    await setOneDriveInvoiceFolder(ctx.tenantId, folderPath, folderItemId);
  } else if (target === "collections") {
    await setOneDriveCollectionsFolder(ctx.tenantId, folderPath, folderItemId);
  } else {
    await setOneDriveFolder(ctx.tenantId, folderPath, folderItemId);
  }

  return NextResponse.json({ success: true, folderPath, folderItemId, target: target || "tripsheets" });
});
