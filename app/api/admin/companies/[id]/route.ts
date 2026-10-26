import { NextRequest, NextResponse } from "next/server";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import {
  CompanyError,
  addCompanyAdmin,
  attachBranch,
  detachBranch,
  setAllocations,
  updateCompany,
} from "@/lib/company";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/admin/companies/[id] — the SUPER_ADMIN's actions on one company:
 *   { action: "update", name?, isActive? }
 *   { action: "attachBranch", tenantId }
 *   { action: "detachBranch", tenantId }       409 while it is allocated
 *   { action: "addCompanyAdmin", name, email, username, password }
 *   { action: "setAllocations", companyAdminId, adminIds[] }
 *
 * Allocations name only branch admins of THIS company; anything else is 404
 * and nothing changes. The allocation table's foreign keys refuse the same
 * thing in the database.
 */
export const PUT = withAuth(async (request: NextRequest, { params }: Ctx) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  try {
    switch (body?.action) {
      case "update":
        await updateCompany(id, { name: body.name, isActive: body.isActive });
        return NextResponse.json({ success: true });
      case "attachBranch":
        await attachBranch(id, body.tenantId);
        return NextResponse.json({ success: true });
      case "detachBranch":
        await detachBranch(id, body.tenantId);
        return NextResponse.json({ success: true });
      case "addCompanyAdmin":
        return NextResponse.json({ companyAdmin: await addCompanyAdmin(id, body) }, { status: 201 });
      case "setAllocations":
        return NextResponse.json(await setAllocations(id, body.companyAdminId, body.adminIds, ctx.userId));
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof CompanyError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
});
