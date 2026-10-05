import { NextRequest, NextResponse } from "next/server";
import { sendCollectionReceiptEmail } from "@/lib/collection-notify";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const runtime = "nodejs";

/** Downloads the signed PDF to attach and waits on an SMTP relay. */
export const maxDuration = 60;

/**
 * The MANUAL send of a collection receipt: the office pushing one that did not
 * go out by itself, or sending another copy. The automatic send when the
 * outcome is recorded is the normal path (lib/collection-notify.ts).
 *
 * `[id]` is a collection id, resolved through the scoped client — a collection
 * belonging to another ADMIN is not found, so this cannot email their customer.
 */
export const POST = withAuth(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  // Pressing Send means "send it now", including another copy of one that
  // already went. An attempt already in flight is still not duplicated.
  const force = body?.force !== false;

  const result = await sendCollectionReceiptEmail(ctx.tenantId, id, { force });

  switch (result.outcome) {
    case "not_signed":
      return NextResponse.json(
        { error: "Collection not found, or it has no signed outcome to send" },
        { status: 404 }
      );
    case "no_email":
      return NextResponse.json({ skipped: true, reason: "No email on file for this customer" });
    case "in_flight":
      return NextResponse.json({
        skipped: true,
        reason: "A receipt for this collection is already being sent",
      });
    case "failed":
      return NextResponse.json({ success: false, error: result.error }, { status: 502 });
    default:
      return NextResponse.json({ success: true, recipient: result.recipient });
  }
});
