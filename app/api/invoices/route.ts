import { NextRequest, NextResponse } from "next/server";
import { listInvoiceFiles, getInvoiceFolderPath, deleteInvoiceFiles, deleteInvoiceOriginalOnly, findDuplicateInvoices } from "@/lib/invoices";
import { getCloudAccountStatus } from "@/lib/microsoft-graph";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import {
  DEFAULT_INVOICE_DELETED_REASON,
  normalizeRemovalReason,
  removeStopsForDeletedInvoices,
} from "@/lib/stop-removal";

export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const cloudStatus = await getCloudAccountStatus(ctx.tenantId);
  const isOneDrive = !!cloudStatus?.invoiceFolderItemId;

  const [invoices, folderPath, duplicates] = await Promise.all([
    listInvoiceFiles(ctx.tenantId),
    getInvoiceFolderPath(ctx.tenantId),
    findDuplicateInvoices(ctx.tenantId),
  ]);

  const signedCount = invoices.filter((i) => i.isSigned).length;
  const unsignedCount = invoices.length - signedCount;

  return NextResponse.json({
    folder: isOneDrive ? `OneDrive: ${cloudStatus!.invoiceFolderPath}` : folderPath,
    source: isOneDrive ? "onedrive" : "local",
    count: invoices.length,
    signedCount,
    unsignedCount,
    invoices,
    duplicates,
  });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const { filenames, mode = "both" } = body;
  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json(
      { error: "filenames array is required" },
      { status: 400 }
    );
  }

  const result = mode === "original_only"
    ? await deleteInvoiceOriginalOnly(ctx.tenantId, filenames)
    : await deleteInvoiceFiles(ctx.tenantId, filenames);

  // An unsigned stop whose PDF is gone has nothing for the driver to present
  // or the customer to sign — the same reason the import gate refuses to
  // deploy one. Take those stops off their runs, only for files that really
  // were deleted. Done here rather than left to the page, so a delete from any
  // client keeps runs consistent. Signed stops stay: the delivery happened.
  const failed = new Set<string>(result.failed);
  const gone = filenames.filter((f: unknown): f is string => typeof f === "string" && !failed.has(f));
  const trips = await removeStopsForDeletedInvoices(ctx.tenantId, gone, {
    reason: normalizeRemovalReason(body.reason) ?? DEFAULT_INVOICE_DELETED_REASON,
    removedBy: ctx.name,
  });

  return NextResponse.json({
    success: true,
    deleted: result.deleted,
    failed: result.failed,
    removedStops: trips.removed,
    signedStopsKept: trips.keptSigned,
  });
});
