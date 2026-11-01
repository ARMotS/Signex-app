import { NextRequest, NextResponse } from "next/server";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { dayWindow, parseTzOffset } from "@/lib/day-window";
import { branchSummary, branchesVisibleTo } from "@/lib/branch-overview";

/**
 * GET /api/company/overview?tzOffset — COMPANY_ADMIN only: today's numbers
 * for each allocated branch, read one branch at a time. Read-only, and works
 * from the company admin's home scope (getSessionContext, not getScope).
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "COMPANY_ADMIN");
  const day = dayWindow(new Date(), parseTzOffset(new URL(request.url).searchParams.get("tzOffset")));
  const branches = await branchesVisibleTo(ctx);
  const summaries = await Promise.all(branches.map((b) => branchSummary(b, day)));
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    viewingTenantId: ctx.isViewingOtherScope ? ctx.tenantId : null,
    branches: summaries,
  });
});
