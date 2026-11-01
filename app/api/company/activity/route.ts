import { NextRequest, NextResponse } from "next/server";
import type { AuditAction } from "@prisma/client";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { parseTzOffset } from "@/lib/day-window";
import { branchActivity, branchesVisibleTo } from "@/lib/branch-overview";

/** The actions a company admin can filter its feed by. Not exported: a route file exports handlers only. */
const ACTIVITY_ACTIONS: AuditAction[] = [
  "SIGN", "UPLOAD", "STATUS_CHANGE", "LOGIN", "LOGOUT", "LOGIN_FAILED", "DRIVER_CREATE", "DRIVER_UPDATE",
  "DRIVER_DELETE", "CONFIG_UPDATE", "PASSWORD_CHANGE", "USERNAME_CHANGE", "ACCOUNT_UPDATE", "EXPORT", "FILE_DELETE",
  "SCOPE_SWITCH",
];
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/company/activity?branch&action&from&to&page&size&tzOffset —
 * COMPANY_ADMIN only: its branches' activity, merged newest first. A branch
 * that is not allocated to the caller is 404. The SUPER_ADMIN's entries, IPs
 * and devices never appear.
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "COMPANY_ADMIN");
  const params = new URL(request.url).searchParams;

  const all = await branchesVisibleTo(ctx);
  const branchId = params.get("branch");
  const branches = branchId ? all.filter((b) => b.tenantId === branchId) : all;
  if (branchId && branches.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const action = params.get("action") as AuditAction | null;
  const day = (k: string) => (DAY.test(params.get(k) ?? "") ? params.get(k)! : "");
  const from = day("from");
  const to = day("to");
  // The viewer's calendar: the day starts at their midnight, not UTC's.
  const offsetMs = parseTzOffset(params.get("tzOffset")) * 60_000;
  const at = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000 + offsetMs);
  const page = Number.parseInt(params.get("page") ?? "", 10);
  const size = Number.parseInt(params.get("size") ?? "", 10);

  const result = await branchActivity(branches, {
    ...(action && ACTIVITY_ACTIONS.includes(action) && { action }),
    ...(from && { from: at(from, 0) }),
    ...(to && { to: at(to, 1) }),
    page: page > 0 ? page : 1,
    size: [25, 50, 100].includes(size) ? size : 25,
  });
  return NextResponse.json({
    ...result,
    branches: all.map((b) => ({ tenantId: b.tenantId, name: b.name })),
    actions: ACTIVITY_ACTIONS,
  });
});
