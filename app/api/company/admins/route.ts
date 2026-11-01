import { NextResponse } from "next/server";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { listMyAdmins } from "@/lib/company-admins";

/**
 * GET /api/company/admins — COMPANY_ADMIN only: the branch admins allocated
 * to the caller. Works from any scope, including the company admin's own
 * home scope, so it uses getSessionContext(), not getScope().
 */
export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "COMPANY_ADMIN");
  return NextResponse.json({ admins: await listMyAdmins(ctx.userId) });
});
