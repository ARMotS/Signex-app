import { NextRequest, NextResponse } from "next/server";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { branchUsage, branchesVisibleTo } from "@/lib/branch-overview";

const PERIODS = [7, 30];

/**
 * GET /api/usage?days=7|30 — who uses Signex, per branch and per account.
 * COMPANY_ADMIN: its allocated branches. SUPER_ADMIN: every branch, with its
 * company. Read one branch at a time; no IP or device detail.
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "COMPANY_ADMIN", "SUPER_ADMIN");
  const asked = Number.parseInt(new URL(request.url).searchParams.get("days") ?? "", 10);
  const days = PERIODS.includes(asked) ? asked : PERIODS[0];
  const now = new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const branches = await branchesVisibleTo(ctx);
  const usage = await Promise.all(branches.map((b) => branchUsage(b, since, now)));
  return NextResponse.json({ days, since: since.toISOString(), generatedAt: now.toISOString(), branches: usage });
});
