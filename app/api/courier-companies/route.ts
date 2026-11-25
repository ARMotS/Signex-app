import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { createCourierCompany, listCourierCompanies } from "@/lib/courier-companies";
import { readCourierCompanyInput, type CourierCompanyInput } from "@/lib/courier-company-input";

/** GET /api/courier-companies — the scope's courier companies (Contacts → Courier companies). Office only. */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireOffice(ctx);
  return NextResponse.json({ courierCompanies: await listCourierCompanies(ctx.tenantId) });
});

/**
 * POST /api/courier-companies
 * Body: { name, contactPerson?, phone?, email?, accountNumber?, notes? }
 *
 * Created in the caller's own scope; a name already in it (case, punctuation
 * and &/and ignored) is a 409.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Send the courier company as JSON." }, { status: 400 });
  }
  const input = readCourierCompanyInput(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const result = await createCourierCompany(ctx.tenantId, input.value as CourierCompanyInput);
  if (!result.success) {
    return NextResponse.json({ error: result.error, code: result.code }, { status: 409 });
  }
  return NextResponse.json({ courierCompany: result.courierCompany }, { status: 201 });
});
