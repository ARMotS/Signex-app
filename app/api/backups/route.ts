import { NextRequest, NextResponse } from "next/server";
import {
  getBackupSummary,
  createBackupZip,
  purgeBackedUpInvoices,
  purgeBackedUpTripSheets,
} from "@/lib/backup";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";

/** Filenames recorded on an audit entry, so a huge selection stays a sane row. */
const MAX_LOGGED_NAMES = 100;
const names = (list: string[]) => list.slice(0, MAX_LOGGED_NAMES);

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
    creditNoteFilenames = [],
  } = body;

  if (
    invoiceFilenames.length === 0 &&
    tripSheetFilenames.length === 0 &&
    collectionFilenames.length === 0 &&
    creditNoteFilenames.length === 0
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
    collectionFilenames,
    creditNoteFilenames
  );

  const datestamp = new Date().toISOString().slice(0, 10);
  const filename = `signex-backup-${datestamp}.zip`;

  await logAudit({
    action: "EXPORT",
    entity: "backup",
    details: `Backup downloaded: ${invoiceFilenames.length} invoices, ${tripSheetFilenames.length} trip sheets, ${collectionFilenames.length} collection receipts, ${creditNoteFilenames.length} credit notes`,
    metadata: {
      format: "zip",
      invoices: invoiceFilenames.length,
      tripSheets: tripSheetFilenames.length,
      collections: collectionFilenames.length,
      creditNotes: creditNoteFilenames.length,
    },
    tenantId: ctx.tenantId,
  });

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
    },
  });
});

/**
 * Purge signed invoices and processed trip sheets only. Collection receipts
 * and signed credit notes are never purged — their Signed/ folders are the
 * record a credit is reconciled against — so those names are not accepted.
 */
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

  // Purging deletes the files for good, so what went is named on the entry.
  await logAudit({
    action: "FILE_DELETE",
    entity: "backup",
    details: `Purged after backup: ${results.invoices.deleted} signed invoices, ${results.tripSheets.deleted} trip sheets`,
    metadata: {
      invoicesDeleted: results.invoices.deleted,
      tripSheetsDeleted: results.tripSheets.deleted,
      invoicesFailed: results.invoices.failed.length,
      tripSheetsFailed: results.tripSheets.failed.length,
      invoiceFilenames: names(invoiceFilenames),
      tripSheetFilenames: names(tripSheetFilenames),
    },
    tenantId: ctx.tenantId,
  });

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
