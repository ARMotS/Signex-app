import { NextRequest, NextResponse } from "next/server";
import {
  getBackupSummary,
  createBackupZip,
  purgeBackedUpInvoices,
  purgeBackedUpTripSheets,
} from "@/lib/backup";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);
  const beforeParam = searchParams.get("before");
  const beforeDate = beforeParam ? new Date(beforeParam) : undefined;

  const summary = await getBackupSummary(ctx.tenantId, beforeDate);
  return NextResponse.json(summary);
});

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const {
    invoiceFilenames = [],
    tripSheetFilenames = [],
    collectionFilenames = [],
  } = body;

  if (
    invoiceFilenames.length === 0 &&
    tripSheetFilenames.length === 0 &&
    collectionFilenames.length === 0
  ) {
    return NextResponse.json(
      { error: "No items selected for backup" },
      { status: 400 }
    );
  }

  const buffer = await createBackupZip(
    ctx.tenantId,
    invoiceFilenames,
    tripSheetFilenames,
    collectionFilenames
  );

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
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const { invoiceFilenames = [], tripSheetFilenames = [] } = body;

  if (invoiceFilenames.length === 0 && tripSheetFilenames.length === 0) {
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
    results.invoices = await purgeBackedUpInvoices(ctx.tenantId, invoiceFilenames);
  }

  if (tripSheetFilenames.length > 0) {
    results.tripSheets = await purgeBackedUpTripSheets(
      ctx.tenantId,
      tripSheetFilenames
    );
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
