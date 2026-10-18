import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { signCreditNote } from "@/lib/credit-signoff";

/**
 * POST /api/credit-notes/[id]/sign
 * Body: { signedByName, signatureImage (PNG data URL), acknowledgement? }
 *
 * The dispatcher signs the note off under their own office login — that is
 * the authority; there is no second approver and no permission flag (the
 * client's decision). Whatever the check found must be acknowledged with a
 * reason (400 with the issues otherwise). The signature is recorded before
 * any filing is attempted, so a OneDrive failure never costs a sign-off: it
 * comes back as `filingError`, and is retried.
 *
 * ADMIN only; another scope's note is 404; already signed or rejected is 409.
 */
export const POST = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await signCreditNote(
    ctx.tenantId,
    id,
    { signedByName: body.signedByName, signatureImage: body.signatureImage, acknowledgement: body.acknowledgement },
    { name: ctx.name, userId: ctx.userId }
  );

  switch (result.outcome) {
    case "not_found":
      return NextResponse.json({ error: "Credit note not found" }, { status: 404 });
    case "closed":
      return NextResponse.json({ error: "This credit note has already been signed or rejected." }, { status: 409 });
    case "invalid":
      return NextResponse.json({ error: result.error, issues: result.issues }, { status: 400 });
    default:
      return NextResponse.json({ success: true, ...result });
  }
});
