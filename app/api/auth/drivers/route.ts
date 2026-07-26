import { NextRequest, NextResponse } from "next/server";
import { UNSAFE_unscopedPrisma, scopedPrisma } from "@/lib/db-scoped";

/**
 * GET /api/auth/drivers?company=<tenant slug>
 *
 * Public. Backs the per-ADMIN driver sign-in link at /select/<slug>: the active
 * drivers belonging to ONE operator.
 *
 * ── History, and why this shape ───────────────────────────────────────────
 * The original version of this endpoint took no parameter and returned every
 * driver in the installation together with their live delivery counts, so anyone
 * could enumerate all of an operator's drivers and see how much work each had.
 * That was the worst pre-authentication leak in the app.
 *
 * There is no longer a public list of operators either — the previous
 * /api/auth/companies endpoint is gone. Reaching this one requires already
 * knowing an operator's slug, which is a random token distributed by that ADMIN.
 *
 * What remains exposed, and to whom:
 *   - `company` is REQUIRED. There is no list-everything mode.
 *   - Only id and name per driver. No delivery counts, no PIN state, no tenantId,
 *     no userId, no timestamps.
 *   - Nothing at all if the operator's owning ADMIN is deactivated, and the
 *     response is identical to an unknown slug so slugs cannot be probed.
 *
 * A slug from the client is acceptable precisely because it grants nothing: it
 * selects which names appear on a login form, and a name without the matching PIN
 * is not a credential. Every authenticated request still derives its scope from
 * the signed session cookie, never from this.
 */
export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("company")?.trim();

  if (!slug) {
    return NextResponse.json(
      { error: "A company link is required" },
      { status: 400 }
    );
  }

  // SCOPE-EXEMPT: pre-session gate. Resolves the slug to a scope and confirms its
  // owning ADMIN is active, before any driver name is revealed. Returns nothing
  // about the scope itself.
  const tenant = await UNSAFE_unscopedPrisma.tenant.findFirst({
    where: { slug, admins: { some: { active: true } } },
    select: { id: true, companyName: true, name: true },
  });

  // Same empty response for "no such slug" and "operator deactivated", so this
  // cannot be used to discover which links are valid.
  if (!tenant) {
    return NextResponse.json({ drivers: [], companyName: null });
  }

  const drivers = await scopedPrisma(tenant.id).driver.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    // Shown as a heading so a driver can tell they opened the right link.
    companyName: tenant.companyName || tenant.name || null,
    drivers,
  });
}
