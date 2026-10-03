import { NextRequest, NextResponse } from "next/server";
import { readConfig, validateFolderPath } from "@/lib/config";
import { assertCollectionsFolderIsSibling } from "@/lib/collections";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const folderPath = body.path;
  const folderType: "invoices" | "tripsheets" | "collections" =
    body.type === "tripsheets" || body.type === "collections" ? body.type : "invoices";

  if (!folderPath || typeof folderPath !== "string") {
    return NextResponse.json(
      { error: "Missing 'path' in request body" },
      { status: 400 }
    );
  }

  const result = validateFolderPath(folderPath, folderType);

  // Testing a collections path is also the moment to say whether it overlaps
  // the invoice folder — the admin is looking at the answer right now, rather
  // than finding out when a driver's paperwork is wrong.
  if (folderType === "collections" && result.valid) {
    const config = await readConfig(ctx.tenantId);
    const sibling = assertCollectionsFolderIsSibling(config.invoiceFolderPath, folderPath);
    if (!sibling.ok) {
      return NextResponse.json({ ...result, valid: false, error: sibling.error });
    }
  }

  return NextResponse.json(result);
});
