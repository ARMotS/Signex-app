import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { normalizeRemovalReason, removeStopFromTrip } from "@/lib/stop-removal";

/**
 * Take an invoice off a live trip sheet — the customer rejected the delivery.
 *
 * ADMIN only: removing a stop changes what a driver is carrying, which is the
 * office's decision. A reason is required and kept on the RemovedStop record.
 * A stop id outside the caller's scope is 404, never 403.
 */
export const DELETE = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;

  const body = await request.json().catch(() => ({}));
  const reason = normalizeRemovalReason(body?.reason);
  if (!reason) {
    return NextResponse.json(
      { error: "A reason is required to remove an invoice from a trip sheet" },
      { status: 400 }
    );
  }

  const result = await removeStopFromTrip(ctx.tenantId, id, {
    reason,
    removedBy: ctx.name,
    source: "REJECTED",
  });

  switch (result.outcome) {
    case "not_found":
      return NextResponse.json({ error: "Stop not found" }, { status: 404 });
    case "signed":
      return NextResponse.json(
        {
          error:
            "This invoice has already been signed for and cannot be removed. Record the returned goods as a credit return instead.",
          code: "STOP_SIGNED",
        },
        { status: 409 }
      );
    case "no_invoice":
      return NextResponse.json(
        { error: "This stop has no invoice to remove", code: "NO_INVOICE" },
        { status: 409 }
      );
    default:
      return NextResponse.json({
        success: true,
        outcome: result.outcome,
        invoiceNumber: result.invoiceNumber,
      });
  }
});
