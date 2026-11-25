import { NextRequest, NextResponse } from "next/server";
import {
  deleteInvoiceFiles,
  deleteInvoiceOriginalOnly,
  duplicateGroupsOf,
  InvoiceFolderUnreadable,
} from "@/lib/invoices";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import { normalizeInvoiceNo } from "@/lib/invoice-number";
import { customerMismatch, detachInvoiceFiles } from "@/lib/invoice-registry";
import { CHAIN_STATUS_LABEL, WIDE_IN_LIST, chainStatuses } from "@/lib/invoice-chain";
import { readInvoiceFolderListing, registerListedInvoices } from "@/lib/invoice-folder-listing";
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

  // Listed once per load (lib/invoice-folder-listing.ts: the index, else the
  // folder itself); duplicates come from that same listing. A folder that
  // cannot be read is an error, never an empty list — "0 invoices" would be
  // shown as fact, with every total wrong.
  let listing: Awaited<ReturnType<typeof readInvoiceFolderListing>>;
  try {
    listing = await readInvoiceFolderListing(ctx.tenantId, startedAt);
  } catch (err) {
    if (err instanceof InvoiceFolderUnreadable) {
      return NextResponse.json({ error: err.message, code: "FOLDER_UNREADABLE" }, { status: 502 });
    }
    throw err;
  }
  const { files, index, isOneDrive, folderLabel, pattern } = listing;
  const duplicates = duplicateGroupsOf(files.map((f) => f.filename));

  // The registry rows supply each file's invoice date and customer; every
  // file gets one. Headers not read yet are read after the response.
  const recordByKey = await registerListedInvoices(ctx.tenantId, files, pattern);

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
    folder: folderLabel,
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
