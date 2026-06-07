import { NextRequest, NextResponse } from "next/server";
import {
  getBackupSummary,
  createBackupZip,
  purgeBackedUpInvoices,
  purgeBackedUpTripSheets,
} from "@/lib/backup";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);
  const beforeParam = searchParams.get("before");
  const beforeDate = beforeParam ? new Date(beforeParam) : undefined;

  const summary = await getBackupSummary(beforeDate, ctx.tenantId);
  return NextResponse.json(summary);
});

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const { invoiceFilenames = [], tripSheetIds = [] } = body;

  if (invoiceFilenames.length === 0 && tripSheetIds.length === 0) {
    return NextResponse.json(
      { error: "No items selected for backup" },
      { status: 400 }
    );
  }

  const buffer = await createBackupZip(invoiceFilenames, tripSheetIds, ctx.tenantId);

  const datestamp = new Date().toISOString().slice(0, 10);
  const filename = `signex-backup-${datestamp}.zip`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
    },
  });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const { invoiceFilenames = [], tripSheetIds = [] } = body;

  if (invoiceFilenames.length === 0 && tripSheetIds.length === 0) {
    return NextResponse.json(
      { error: "No items selected for purge" },
      { status: 400 }
    );
  }

  const results = {
    invoices: { deleted: 0, failed: [] as string[] },
    tripSheets: { deleted: 0, failed: [] as string[] },
  };

  if (invoiceFilenames.length > 0) {
    results.invoices = await purgeBackedUpInvoices(invoiceFilenames);
  }

  if (tripSheetIds.length > 0) {
    results.tripSheets = await purgeBackedUpTripSheets(tripSheetIds, ctx.tenantId);
  }

  return NextResponse.json({
    success: true,
    purged: {
      invoicesDeleted: results.invoices.deleted,
      invoicesFailed: results.invoices.failed,
      tripSheetsDeleted: results.tripSheets.deleted,
      tripSheetsFailed: results.tripSheets.failed,
    },
  });
});
