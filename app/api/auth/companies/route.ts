import { NextResponse } from "next/server";
import { UNSAFE_unscopedPrisma } from "@/lib/db-scoped";

/**
 * GET /api/auth/companies
 *
 * Public. Populates the first dropdown on the driver sign-in page.
 *
 * ── What this deliberately exposes ────────────────────────────────────────
 * Company names only. Nothing else about a scope crosses this boundary: no
 * driver names, no counts, no emails, no admin identity, no OneDrive details.
 *
 * A scope appears only if BOTH:
 *   - its owning ADMIN is active (a deactivated company disappears), and
 *   - it has at least one active driver (so empty scopes are not advertised).
 *
 * The returned id is the tenant id, which the driver-list endpoint then takes as
 * a filter. That is safe because the id grants nothing on its own — it only ever
 * selects which company's driver names to show on a login form, and every
 * authenticated request still derives its scope from the session cookie.
 */
export async function GET() {
  // SCOPE-EXEMPT: pre-session. The driver has no scope yet — choosing one is the
  // purpose of this endpoint. Projection is limited to id + display name.
  const tenants = await UNSAFE_unscopedPrisma.tenant.findMany({
    where: {
      // Owning admin must be active.
      admins: { some: { active: true } },
      // Must actually have drivers to sign in.
      drivers: { some: { active: true } },
    },
    select: {
      id: true,
      companyName: true,
      name: true,
    },
  });

  const companies = tenants
    .map((t) => ({
      id: t.id,
      name: (t.companyName || t.name || "").trim(),
    }))
    .filter((c) => c.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return NextResponse.json({ companies });
}
