import { NextRequest, NextResponse } from "next/server";
import { listInvoiceFiles, getInvoiceFolderPath, deleteInvoiceFiles, deleteInvoiceOriginalOnly, findDuplicateInvoices } from "@/lib/invoices";
import { getCloudAccountStatus } from "@/lib/microsoft-graph";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

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

  const { filenames, mode = "both" } = await request.json();
  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json(
      { error: "filenames array is required" },
      { status: 400 }
    );
  }

  const result = mode === "original_only"
    ? await deleteInvoiceOriginalOnly(ctx.tenantId, filenames)
    : await deleteInvoiceFiles(ctx.tenantId, filenames);

  return NextResponse.json({
    success: true,
    deleted: result.deleted,
    failed: result.failed,
  });
});
