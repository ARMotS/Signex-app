import { NextRequest, NextResponse } from "next/server";
import { readConfig, writeConfig, validateFolderPath } from "@/lib/config";
import { assertCollectionsFolderIsSibling } from "@/lib/collections";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  // Per-scope settings: folder paths and signature position belong to this ADMIN.
  const config = await readConfig(ctx.tenantId);
  return NextResponse.json(config);
});

export const PUT = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();

  if (body.invoiceFolderPath !== undefined && body.invoiceFolderPath !== "") {
    const validation = validateFolderPath(body.invoiceFolderPath);
    if (!validation.valid) {
      return NextResponse.json(
        {
          error: `Invalid invoice folder path: ${validation.error}`,
          validation,
        },
        { status: 400 }
      );
    }
  }

  if (body.tripSheetFolderPath !== undefined && body.tripSheetFolderPath !== "") {
    const validation = validateFolderPath(body.tripSheetFolderPath);
    if (!validation.valid) {
      return NextResponse.json(
        {
          error: `Invalid trip sheet folder path: ${validation.error}`,
          validation,
        },
        { status: 400 }
      );
    }
  }

  if (body.collectionsFolderPath !== undefined && body.collectionsFolderPath !== "") {
    const validation = validateFolderPath(body.collectionsFolderPath, "collections");
    if (!validation.valid) {
      return NextResponse.json(
        {
          error: `Invalid collections folder path: ${validation.error}`,
          validation,
        },
        { status: 400 }
      );
    }
  }

  // Invoices and collections are siblings, never nested. Checked against the
  // values this request would leave behind rather than the ones already stored,
  // so moving either folder is validated against the other's new position too.
  if (
    body.invoiceFolderPath !== undefined ||
    body.collectionsFolderPath !== undefined
  ) {
    const current = await readConfig(ctx.tenantId);
    const sibling = assertCollectionsFolderIsSibling(
      body.invoiceFolderPath ?? current.invoiceFolderPath,
      body.collectionsFolderPath ?? current.collectionsFolderPath
    );
    if (!sibling.ok) {
      return NextResponse.json({ error: sibling.error }, { status: 400 });
    }
  }

  const updated = await writeConfig(ctx.tenantId, body);
  return NextResponse.json({
    success: true,
    config: updated,
  });
});
