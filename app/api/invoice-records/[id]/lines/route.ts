import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { getInvoiceLines, readInvoiceLines } from "@/lib/invoice-lines";

// A scan or an unknown layout is read by Claude, inside this request.
export const maxDuration = 60;

/**
 * An invoice's product lines and the state of their reading
 * (lib/invoice-lines.ts) — quantities only, nothing priced. Office only;
 * another scope's id is 404 through the scoped client.
 */
export const GET = withAuth(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;

  const view = await getInvoiceLines(ctx.tenantId, id);
  if (!view) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  return NextResponse.json(view);
});

/**
 * Read the lines now, one invoice per request. Answers at once from what is
 * stored when this PDF has been read already; `{ force: true }` reads it
 * again. Lines typed in by hand are never replaced by a read.
 */
export const POST = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await readInvoiceLines(ctx.tenantId, id, { force: body?.force === true });
  if (!result) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  return NextResponse.json({ outcome: result.outcome, ...result.view });
});
