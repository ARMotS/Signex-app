import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import { parseInvoiceDate } from "@/lib/invoice-header";

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
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
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
