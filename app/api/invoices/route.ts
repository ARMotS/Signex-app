import { NextRequest, NextResponse } from "next/server";
import { listInvoiceFiles, getInvoiceFolderPath, deleteInvoiceFiles, deleteInvoiceOriginalOnly, findDuplicateInvoices } from "@/lib/invoices";
import { getCloudAccountStatus } from "@/lib/microsoft-graph";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import { readInvoiceNoPattern } from "@/lib/config";
import { normalizeInvoiceNo } from "@/lib/invoice-number";
import {
  customerMismatch,
  detachInvoiceFiles,
  ensureInvoices,
  scheduleInvoiceHeaders,
} from "@/lib/invoice-registry";
import { CHAIN_STATUS_LABEL, chainStatuses } from "@/lib/invoice-chain";
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

  const [files, folderPath, duplicates, pattern] = await Promise.all([
    listInvoiceFiles(ctx.tenantId),
    getInvoiceFolderPath(ctx.tenantId),
    findDuplicateInvoices(ctx.tenantId),
    readInvoiceNoPattern(ctx.tenantId),
  ]);

  // Every file seen gets a registry row ("fill": a listing never re-points an
  // invoice at a different copy of itself), then the rows supply each file's
  // invoice date and customer. Headers not read yet are read after the
  // response — this page lists the folder, it does not wait on PDFs.
  await ensureInvoices(
    ctx.tenantId,
    files.map((f) => ({ invoiceNo: f.name, pdfFilename: f.filename })),
    pattern,
    { fileAuthority: "fill" }
  );
  const records = await ctx.db.invoice.findMany({
    select: {
      id: true,
      invoiceNoNormalized: true,
      customerName: true,
      deliverToName: true,
      billToName: true,
      invoiceDate: true,
      headerSource: true,
      headerError: true,
      isStub: true,
    },
  });
  const recordByKey = new Map(records.map((r) => [r.invoiceNoNormalized, r]));
  scheduleInvoiceHeaders(ctx.tenantId, { limit: 25 });

  // Where each invoice's chain stands (delivered → collected → credited), for
  // the Invoices tab's status column. Two queries for the whole listing.
  const rowOf = files.map((f) => recordByKey.get(normalizeInvoiceNo(f.invoiceNumber, pattern)));
  const delivered = new Map<string, boolean>();
  files.forEach((f, i) => {
    const r = rowOf[i];
    if (r) delivered.set(r.id, (delivered.get(r.id) ?? false) || f.isSigned);
  });
  const statuses = await chainStatuses(ctx.tenantId, [...delivered.keys()], delivered);

  // Delivery method: an invoice on a courier trip sheet goes by courier; any
  // other goes with one of our drivers. One query for the whole listing.
  const keys = [...new Set(files.map((f) => normalizeInvoiceNo(f.invoiceNumber, pattern)).filter(Boolean))];
  const courierLines = keys.length
    ? await ctx.db.courierTripSheetInvoice.findMany({
        where: { invoiceNoNormalized: { in: keys } },
        select: { invoiceNoNormalized: true, courierSheet: { select: { id: true, courierSheetNo: true, status: true } } },
      })
    : [];
  const courierByKey = new Map(courierLines.map((l) => [l.invoiceNoNormalized, l.courierSheet]));

  const invoices = files.map((f, i) => {
    const r = rowOf[i];
    const chain = r ? statuses.get(r.id) ?? null : null;
    const courier = courierByKey.get(normalizeInvoiceNo(f.invoiceNumber, pattern)) ?? null;
    return {
      ...f,
      deliveryMethod: courier ? ("COURIER" as const) : ("IN_HOUSE" as const),
      courier,
      recordId: r?.id ?? null,
      chainStatus: chain,
      chainLabel: chain ? CHAIN_STATUS_LABEL[chain] : null,
      invoiceDate: r?.invoiceDate ? r.invoiceDate.toISOString().slice(0, 10) : null,
      // The trip sheet's name wins; until a sheet names it, the PDF's.
      customerName: r?.customerName ?? r?.deliverToName ?? r?.billToName ?? null,
      pdfCustomerName: r?.deliverToName ?? r?.billToName ?? null,
      customerMismatch: r ? customerMismatch(r.customerName, r.deliverToName, r.billToName) : false,
      headerSource: r?.headerSource ?? null,
      headerError: r?.headerSource ? null : r?.headerError ?? null,
    };
  });

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
  // The invoice record stays (it anchors what was delivered and collected
  // against it); it just no longer has a PDF.
  await detachInvoiceFiles(ctx.tenantId, gone);
  const trips = await removeStopsForDeletedInvoices(ctx.tenantId, gone, {
    reason: normalizeRemovalReason(body.reason) ?? DEFAULT_INVOICE_DELETED_REASON,
    removedBy: ctx.name,
  });

  if (gone.length > 0) {
    await logAudit({
      action: "FILE_DELETE",
      entity: "invoice",
      details: `Deleted ${gone.length} invoice PDF${gone.length === 1 ? "" : "s"} (${mode === "original_only" ? "original only" : "original and signed"})`,
      metadata: { mode, filenames: gone.slice(0, 100), count: gone.length },
      tenantId: ctx.tenantId,
    });
  }

  return NextResponse.json({
    success: true,
    deleted: result.deleted,
    failed: result.failed,
    removedStops: trips.removed,
    signedStopsKept: trips.keptSigned,
  });
});
