import { NextRequest, NextResponse } from "next/server";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { CompanyAdminActionError, updateMyAdmin } from "@/lib/company-admins";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/company/admins/[id] — COMPANY_ADMIN only.
 *   { username }   change an allocated admin's username (globally unique; 409 on a clash)
 *   { password }   reset its password, signing it out of every device
 *
 * The id must be a branch admin allocated to the caller in its own, active
 * company; anything else is 404 and nothing is written.
 */
export const PUT = withAuth(async (request: NextRequest, { params }: Ctx) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "COMPANY_ADMIN");
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  try {
    await updateMyAdmin(ctx.userId, id, { username: body?.username, password: body?.password });
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof CompanyAdminActionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
});
