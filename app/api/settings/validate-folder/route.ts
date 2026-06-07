import { NextRequest, NextResponse } from "next/server";
import { validateFolderPath } from "@/lib/config";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const folderPath = body.path;
  const folderType: "invoices" | "tripsheets" = body.type === "tripsheets" ? "tripsheets" : "invoices";

  if (!folderPath || typeof folderPath !== "string") {
    return NextResponse.json(
      { error: "Missing 'path' in request body" },
      { status: 400 }
    );
  }

  const result = validateFolderPath(folderPath, folderType);
  return NextResponse.json(result);
});
