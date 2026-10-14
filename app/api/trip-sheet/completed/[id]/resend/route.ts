import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { resendArchivedConfirmation, MAX_ARCHIVE_RESENDS } from "@/lib/archive-resend";

export const runtime = "nodejs";

/** Downloads the signed PDF and waits on an SMTP relay, like the live resend. */
export const maxDuration = 60;

/**
 * Resend a delivery confirmation from a COMPLETED trip sheet — at most
 * MAX_ARCHIVE_RESENDS times per delivery. See lib/archive-resend.ts.
 *
 * `[id]` is a CompletedTripSheet id; the body names the stop by its number.
 * Resolved through the scoped client, so another ADMIN's archive is a 404.
 */
export const POST = withAuth(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const stopNumber = Number(body?.stopNumber);
  if (!Number.isInteger(stopNumber)) {
    return NextResponse.json({ error: "stopNumber is required" }, { status: 400 });
  }

  const result = await resendArchivedConfirmation(ctx.tenantId, id, stopNumber, ctx.name ?? null);
  const usage = { used: result.used, limit: MAX_ARCHIVE_RESENDS };

  switch (result.outcome) {
    case "not_found":
      return NextResponse.json({ error: "Delivery not found", ...usage }, { status: 404 });
    case "no_email":
      return NextResponse.json(
        { error: "No email address on file for this customer — add one on the Contacts page", ...usage },
        { status: 422 }
      );
    case "limit_reached":
      return NextResponse.json(
        { error: `This confirmation has already been resent ${MAX_ARCHIVE_RESENDS} times`, ...usage },
        { status: 429 }
      );
    case "in_flight":
      return NextResponse.json(
        { error: "A resend for this delivery is already in progress", ...usage },
        { status: 409 }
      );
    case "failed":
      return NextResponse.json(
        { error: result.error ?? "Failed to send", recipient: result.recipient, ...usage },
        { status: 502 }
      );
    case "sent":
      return NextResponse.json({
        success: true,
        recipient: result.recipient,
        attached: result.attached,
        ...usage,
      });
  }
});
