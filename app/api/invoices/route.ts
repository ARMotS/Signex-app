import { NextRequest, NextResponse } from "next/server";
import {
  listInvoiceFiles,
  getInvoiceFolderPath,
  deleteInvoiceFiles,
  deleteInvoiceOriginalOnly,
  duplicateGroupsOf,
  InvoiceFolderUnreadable,
} from "@/lib/invoices";
import { getCloudAccountStatus } from "@/lib/microsoft-graph";
import { getScope, requireOffice } from "@/lib/tenant";
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
import { CHAIN_STATUS_LABEL, WIDE_IN_LIST, chainStatuses } from "@/lib/invoice-chain";
import { readInvoiceIndex, type InvoiceIndexStatus } from "@/lib/invoice-index";
import { scheduleInvoiceIndexSync } from "@/lib/invoice-index-sync";
import {
  DEFAULT_INVOICE_DELETED_REASON,
  normalizeRemovalReason,
  removeStopsForDeletedInvoices,
} from "@/lib/stop-removal";

// The first look at a big folder runs after the response (scheduleInvoiceIndexSync).
export const maxDuration = 60;

export const GET = withAuth(async () => {
  const startedAt = Date.now();
  const ctx = await getScope();
  requireOffice(ctx);

  const cloudStatus = await getCloudAccountStatus(ctx.tenantId);
  const isOneDrive = !!cloudStatus?.invoiceFolderItemId;

  // The folder as the index last saw it (lib/invoice-index.ts) — no Graph at
  // all. Until the index has finished its first pass, or after another folder
  // is chosen, the folder is listed here as it always was.
  const [indexed, folderPath, pattern] = await Promise.all([
    isOneDrive ? readInvoiceIndex(ctx.tenantId) : null,
    getInvoiceFolderPath(ctx.tenantId),
    readInvoiceNoPattern(ctx.tenantId),
  ]);
  const index: InvoiceIndexStatus = indexed?.status ?? { state: "off", syncedAt: null, error: null };

  // Listed once per load; duplicates come from that same listing. A folder
  // that cannot be read is an error, never an empty list — "0 invoices" would
  // be shown as fact, with every total wrong.
  let files: Awaited<ReturnType<typeof listInvoiceFiles>>;
  if (indexed?.files) {
    files = indexed.files;
  } else {
    try {
      files = await listInvoiceFiles(ctx.tenantId, { strict: true });
    } catch (err) {
      if (err instanceof InvoiceFolderUnreadable) {
        if (isOneDrive) scheduleInvoiceIndexSync(ctx.tenantId, 40_000);
        return NextResponse.json({ error: err.message, code: "FOLDER_UNREADABLE" }, { status: 502 });
      }
      throw err;
    }
  }
  // Catch up with the folder after the response: usually one small request,
  // the whole first pass on a branch that has none yet. What is left of this
  // function's time is its budget; progress is saved page by page.
  if (isOneDrive) {
    scheduleInvoiceIndexSync(ctx.tenantId, Math.max(10_000, 50_000 - (Date.now() - startedAt)));
  }
  const duplicates = duplicateGroupsOf(files.map((f) => f.filename));

  // The registry rows supply each file's invoice date and customer. Headers
  // not read yet are read after the response — this page does not wait on PDFs.
  const recordSelect = {
    id: true,
    invoiceNoNormalized: true,
    pdfFilename: true,
    customerName: true,
    deliverToName: true,
    billToName: true,
    invoiceDate: true,
    headerSource: true,
    headerError: true,
    isStub: true,
  } as const;
  let records = await ctx.db.invoice.findMany({ select: recordSelect });
  // Every file gets a registry row ("fill": a listing never re-points an
  // invoice at a different copy of itself). Only files that need it are
  // passed — no row yet, or a row with no PDF recorded (a stub whose PDF has
  // turned up) — not every file on every load.
  const recordByKey = new Map(records.map((r) => [r.invoiceNoNormalized, r]));
  const needRow = files.filter((f) => {
    const key = normalizeInvoiceNo(f.name, pattern);
    if (!key) return false; // no number in the name: never gets a row
    const r = recordByKey.get(key);
    return !r || !r.pdfFilename;
  });
  if (needRow.length > 0) {
    await ensureInvoices(
      ctx.tenantId,
      needRow.map((f) => ({ invoiceNo: f.name, pdfFilename: f.filename })),
      pattern,
      { fileAuthority: "fill" }
    );
    records = await ctx.db.invoice.findMany({ select: recordSelect });
    recordByKey.clear();
    for (const r of records) recordByKey.set(r.invoiceNoNormalized, r);
  }
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
  // A folder of thousands: read the scope's courier lines rather than send
  // every number as an IN list (only listed numbers are looked up below).
  const courierLines = keys.length
    ? await ctx.db.courierTripSheetInvoice.findMany({
        where: keys.length > WIDE_IN_LIST ? {} : { invoiceNoNormalized: { in: keys } },
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
    index,
  });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireOffice(ctx);

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
