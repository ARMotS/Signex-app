import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { reviewCreditCollection } from "@/lib/collection-review";

/**
 * PUT /api/collections/[id]/review  { decision: "APPROVE" | "REJECT", reason? }
 *
 * The office approves a credit return that came back for credit, or rejects
 * it (reason required). Until it does, the trip cannot be completed.
 *
 * ADMIN only — the dispatcher's decision, never the driver's. Another scope's
 * collection is 404; one that needs no decision, or whose trip is completed,
 * is 409.
 */
export const PUT = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await reviewCreditCollection(ctx.tenantId, id, body.decision, body.reason, ctx.name);
  switch (result.outcome) {
    case "not_found":
      return NextResponse.json({ error: "Collection not found" }, { status: 404 });
    case "invalid":
      return NextResponse.json({ error: result.error }, { status: 400 });
    case "not_reviewable":
    case "archived":
      return NextResponse.json({ error: result.error }, { status: 409 });
    default:
      return NextResponse.json({ success: true, creditReview: result.creditReview });
  }
});
