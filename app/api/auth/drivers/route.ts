import { NextRequest, NextResponse } from "next/server";
import { UNSAFE_unscopedPrisma, scopedPrisma } from "@/lib/db-scoped";

/**
 * GET /api/auth/drivers?company=<tenantId>
 *
 * Public. Populates the second dropdown on the driver sign-in page: the active
 * drivers belonging to ONE company.
 *
 * ── History, and why this shape ───────────────────────────────────────────
 * The previous version of this endpoint took no parameter and returned every
 * driver in the installation together with their live delivery counts, so anyone
 * could enumerate all of an operator's drivers and see how much work each had.
 * That was the worst pre-auth leak in the app.
 *
 * This version narrows it as far as the requested UX allows:
 *   - `company` is REQUIRED. There is no "list everything" mode.
 *   - Results are confined to that one scope, via the scoped client.
 *   - Only id and name are returned. Delivery counts, PIN state, tenantId,
 *     userId and timestamps are all withheld — the old counts leak is gone.
 *   - Nothing is returned at all if the company's owning ADMIN is deactivated.
 *
 * A `company` value from the client is acceptable here precisely because it
 * grants nothing: it selects which names appear on a login form, and a name
 * without the matching PIN is not a credential. Every authenticated request
 * still derives its scope from the signed session cookie, never from this.
 */
export async function GET(request: NextRequest) {
  const company = request.nextUrl.searchParams.get("company")?.trim();

  if (!company) {
    return NextResponse.json(
      { error: "A company must be selected" },
      { status: 400 }
    );
  }

  // SCOPE-EXEMPT: pre-session gate. Confirms the requested scope exists and its
  // owning ADMIN is active, before any driver name is revealed. Returns nothing
  // about the scope itself.
  const tenant = await UNSAFE_unscopedPrisma.tenant.findFirst({
    where: { id: company, admins: { some: { active: true } } },
    select: { id: true },
  });

  // Same empty response for "no such company" and "company deactivated", so this
  // cannot be used to probe which tenant ids exist.
  if (!tenant) {
    return NextResponse.json({ drivers: [] });
  }

  const drivers = await scopedPrisma(tenant.id).driver.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ drivers });
}
