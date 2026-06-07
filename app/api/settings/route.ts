import { NextRequest, NextResponse } from "next/server";
import { readConfig, writeConfig, validateFolderPath } from "@/lib/config";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const config = await readConfig();
  return NextResponse.json(config);
});

export const PUT = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
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

  const updated = await writeConfig(body);
  return NextResponse.json({
    success: true,
    config: updated,
  });
});
