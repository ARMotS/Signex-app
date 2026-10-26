import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import { parseInvoiceDate } from "@/lib/invoice-header";
import { CHAIN_STATUS_LABEL, loadInvoiceChain } from "@/lib/invoice-chain";

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * The invoice chain: the invoice, its delivery, the collections credited
 * against it and the credit notes that paid for them, with a per-item
 * balance (lib/invoice-chain.ts). ADMIN only; another scope's id is 404.
 * Nothing priced beyond the credit notes' own totals, which only the office sees.
 */
export const GET = withAuth(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;

  const chain = await loadInvoiceChain(ctx.tenantId, id);
  if (!chain) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  const { invoice } = chain;

  return NextResponse.json({
    invoice: {
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      invoiceDate: day(invoice.invoiceDate),
      customerName: invoice.customerName ?? invoice.deliverToName ?? invoice.billToName,
      pdfFilename: invoice.pdfFilename,
      isStub: invoice.isStub,
    },
    status: chain.status,
    statusLabel: CHAIN_STATUS_LABEL[chain.status],
    deliveries: [
      ...chain.deliveries.live.map((s) => ({
        live: true,
        driverName: s.tripSheet?.driver?.name ?? null,
        tripDate: iso(s.tripSheet?.date),
        sourceFilename: s.tripSheet?.sourceFilename ?? null,
        stopNumber: s.stopNumber,
        signed: s.status === "SIGNED",
        signedAt: iso(s.signedAt),
        signedByName: s.signedByName,
        invoiceFile: s.invoiceFile,
      })),
      ...chain.deliveries.archived.map((s) => ({
        live: false,
        driverName: s.driverName,
        tripDate: iso(s.tripDate),
        sourceFilename: s.sourceFilename,
        stopNumber: s.stopNumber,
        signed: !!s.signedAt,
        signedAt: iso(s.signedAt),
        signedByName: s.signedByName,
        invoiceFile: invoice.pdfFilename,
      })),
    ],
    collections: chain.collections.map((c) => ({
      id: c.id,
      collectionNo: c.collectionNo,
      type: c.type,
      originalInvoiceNo: c.originalInvoiceNo,
      status: c.status,
      collectedAt: iso(c.collectedAt),
      expectedQty: c.expectedQty,
      collectedQty: c.collectedQty,
      hasVariance: c.hasVariance,
      exceptionReason: c.exceptionReason,
      creditReview: c.creditReview,
      creditReviewReason: c.creditReviewReason,
      live: !!c.tripSheetId,
      signedFilePath: c.signedFilePath,
      sourceFilePath: c.sourceFilePath,
      itemsListed: c.lines.filter((l) => !l.isExtra).reduce((n, l) => n + l.qtyListed, 0),
      itemsCollected: c.lines.reduce((n, l) => n + (l.qtyCollected ?? 0), 0),
      hasLines: c.lines.length > 0,
    })),
    creditNotes: chain.creditNotes.map((n) => ({
      id: n.id,
      creditNo: n.creditNo,
      creditDate: day(n.creditDate),
      total: n.total === null ? null : Number(n.total),
      status: n.status,
      signedAt: iso(n.signedAt),
      signedByName: n.signedByName,
      signedFilename: n.signedFilename,
      collectionIds: n.collections.map((l) => l.collectionId),
      allocations: n.allocations.map((a) => ({ collectionId: a.collectionId, collectionNo: a.collectionNo, itemCode: a.itemCode, qty: Number(a.qty) })),
    })),
    balance: chain.balance,
  });
});

/**
 * Correct an invoice's date or customer by hand — for a scan nobody could
 * read, or a PDF whose header was read wrong.
 *
 * ADMIN only, and addressed by the registry row's id (the Invoices page has it
 * as `recordId`); an id from another scope is 404 through the scoped client.
 * A corrected date marks the header MANUAL, so a background read finishing
 * later never overwrites what a person decided.
 */
export const PATCH = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;

  const existing = await ctx.db.invoice.findFirst({
    where: { id },
    select: { id: true, invoiceNo: true, invoiceDate: true, customerName: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const data: { invoiceDate?: Date | null; customerName?: string | null; headerSource?: string } = {};

  if (body.invoiceDate !== undefined) {
    if (body.invoiceDate === null || body.invoiceDate === "") {
      data.invoiceDate = null;
    } else {
      const parsed = parseInvoiceDate(String(body.invoiceDate));
      if (!parsed) {
        return NextResponse.json({ error: "Invoice date must be a real date, e.g. 2026-10-14" }, { status: 400 });
      }
      data.invoiceDate = parsed;
    }
    data.headerSource = "MANUAL";
  }

  if (body.customerName !== undefined) {
    const name = String(body.customerName ?? "").trim().slice(0, 200);
    data.customerName = name || null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }

  const updated = await ctx.db.invoice.update({ where: { id }, data });

  const changes = [
    data.invoiceDate !== undefined &&
      `date ${existing.invoiceDate?.toISOString().slice(0, 10) ?? "—"} → ${updated.invoiceDate?.toISOString().slice(0, 10) ?? "—"}`,
    data.customerName !== undefined && `customer "${existing.customerName ?? ""}" → "${updated.customerName ?? ""}"`,
  ].filter(Boolean);
  await logAudit({
    action: "STATUS_CHANGE",
    entity: "invoice",
    entityId: id,
    userName: ctx.name,
    details: `Invoice ${existing.invoiceNo} corrected by hand: ${changes.join("; ")}`,
    tenantId: ctx.tenantId,
  });

  return NextResponse.json({
    success: true,
    invoiceDate: updated.invoiceDate?.toISOString().slice(0, 10) ?? null,
    customerName: updated.customerName,
  });
});
