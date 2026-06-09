import { NextRequest, NextResponse } from "next/server";
import { listInvoiceFiles, getInvoiceFolderPath, deleteInvoiceFiles, findDuplicateInvoices } from "@/lib/invoices";
import { listOneDriveInvoiceFiles, getCloudAccountStatus } from "@/lib/microsoft-graph";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  // Check if OneDrive invoice folder is configured
  const cloudStatus = await getCloudAccountStatus();
  if (cloudStatus?.invoiceFolderItemId) {
    const files = await listOneDriveInvoiceFiles();
    const invoices = files.map((f) => ({
      name: f.name.replace(/\.pdf$/i, ""),
      filename: f.name,
      sizeBytes: f.size,
      lastModified: f.lastModifiedDateTime,
      invoiceNumber: f.name.replace(/\.pdf$/i, "").toUpperCase(),
      isSigned: false,
      oneDriveItemId: f.id,
    }));

    return NextResponse.json({
      folder: `OneDrive: ${cloudStatus.invoiceFolderPath}`,
      source: "onedrive",
      count: invoices.length,
      signedCount: 0,
      unsignedCount: invoices.length,
      invoices,
      duplicates: [],
    });
  }

  // Fall back to local filesystem
  const [invoices, folderPath, duplicates] = await Promise.all([
    listInvoiceFiles(),
    getInvoiceFolderPath(),
    findDuplicateInvoices(),
  ]);

  const signedCount = invoices.filter((i) => i.isSigned).length;
  const unsignedCount = invoices.length - signedCount;

  return NextResponse.json({
    folder: folderPath,
    source: "local",
    count: invoices.length,
    signedCount,
    unsignedCount,
    invoices,
    duplicates,
  });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { filenames } = await request.json();
  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json(
      { error: "filenames array is required" },
      { status: 400 }
    );
  }

  const result = await deleteInvoiceFiles(filenames);

  return NextResponse.json({
    success: true,
    deleted: result.deleted,
    failed: result.failed,
  });
});
