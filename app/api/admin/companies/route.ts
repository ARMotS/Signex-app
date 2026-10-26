import { NextRequest, NextResponse } from "next/server";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { CompanyError, createCompany, listCompanies } from "@/lib/company";

/**
 * The SUPER_ADMIN's company console.
 *
 * Companies own branches, and their COMPANY_ADMIN accounts oversee the branch
 * admins allocated to them. This is the registry of all of that, so it spans
 * scopes by nature (lib/company.ts carries the SCOPE-EXEMPT reads) and is
 * SUPER_ADMIN-only. It returns account metadata, never branch data.
 */

/** GET /api/admin/companies — every company, plus the branches no company has. */
export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");
  return NextResponse.json(await listCompanies());
});

/** POST /api/admin/companies { name } — a new company and its home scope. */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");
  const body = await request.json().catch(() => ({}));
  try {
    const company = await createCompany(body?.name);
    return NextResponse.json({ company }, { status: 201 });
  } catch (err) {
    if (err instanceof CompanyError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
});
