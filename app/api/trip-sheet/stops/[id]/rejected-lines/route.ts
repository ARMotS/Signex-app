import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { addRejectedLine, deleteRejectedLine, parseRejectedLine } from "@/lib/stop-removal";

/**
 * Lines of an invoice the customer refused while accepting the rest.
 *
 * POST records one; DELETE ({ lineId }) withdraws one recorded in error. Both
 * are refused once the stop is signed — the signed PDF already states what was
 * accepted. ADMIN only, like removing the whole invoice.
 */
export const POST = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const parsed = parseRejectedLine(await request.json().catch(() => null));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const result = await addRejectedLine(ctx.tenantId, id, parsed.line, ctx.name);
  return respond(result.outcome, result.outcome === "recorded" ? { id: result.id } : {});
});

export const DELETE = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const body = await request.json().catch(() => ({}));
  const lineId = typeof body?.lineId === "string" ? body.lineId : "";
  if (!lineId) {
    return NextResponse.json({ error: "lineId is required" }, { status: 400 });
  }

  const result = await deleteRejectedLine(ctx.tenantId, id, lineId, ctx.name);
  return respond(result.outcome, {});
});

function respond(outcome: string, extra: Record<string, unknown>) {
  switch (outcome) {
    case "not_found":
      return NextResponse.json({ error: "Stop not found" }, { status: 404 });
    case "signed":
      return NextResponse.json(
        { error: "This invoice has already been signed for", code: "STOP_SIGNED" },
        { status: 409 }
      );
    case "no_invoice":
      return NextResponse.json(
        { error: "This stop has no invoice", code: "NO_INVOICE" },
        { status: 409 }
      );
    default:
      return NextResponse.json({ success: true, ...extra });
  }
}
