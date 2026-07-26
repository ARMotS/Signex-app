import { NextRequest, NextResponse } from "next/server";
import { UNSAFE_unscopedPrisma } from "@/lib/db-scoped";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { setViewScope } from "@/lib/session";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";

/**
 * The SUPER_ADMIN scope switcher.
 *
 * Cross-scope access is an explicit, audited mode rather than an implicit
 * "SUPER_ADMIN sees everything". The active scope lives in the HMAC-signed
 * session cookie as `viewTenantId` and is only ever written here, behind a
 * SUPER_ADMIN role check. A client that edits the cookie invalidates its
 * signature; a client cannot pass a scope on a data request at all.
 *
 * `viewTenantId` is read only for SUPER_ADMIN sessions (see getSessionContext),
 * so an ADMIN or DRIVER session is hard-locked to its own scope regardless.
 */

/**
 * GET /api/admin/scopes
 * Every scope, its owning ADMIN, and how much data sits in it.
 */
export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");

  // SCOPE-EXEMPT: the Tenant table IS the scope registry. SUPER_ADMIN-gated.
  const tenants = await UNSAFE_unscopedPrisma.tenant.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      createdAt: true,
      admins: {
        select: { id: true, name: true, email: true },
        orderBy: { createdAt: "asc" },
      },
      _count: {
        select: {
          drivers: true,
          contacts: true,
          tripSheets: true,
          stops: true,
        },
      },
    },
  });

  return NextResponse.json({
    activeTenantId: ctx.tenantId,
    homeTenantId: ctx.homeTenantId,
    isViewingOtherScope: ctx.isViewingOtherScope,
    scopes: tenants.map((t) => ({
      tenantId: t.id,
      name: t.name,
      slug: t.slug,
      createdAt: t.createdAt,
      isHome: t.id === ctx.homeTenantId,
      isActive: t.id === ctx.tenantId,
      admins: t.admins,
      counts: t._count,
    })),
  });
});

/**
 * POST /api/admin/scopes
 * Body: { tenantId: string | null }
 *
 * Switch the active scope. `null` returns to the SUPER_ADMIN's own scope.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");

  const { tenantId } = await request.json();

  if (tenantId !== null && typeof tenantId !== "string") {
    return NextResponse.json(
      { error: "tenantId must be a string, or null to return to your own scope" },
      { status: 400 }
    );
  }

  if (tenantId === null || tenantId === ctx.homeTenantId) {
    await setViewScope(null);
    await logAudit({
      action: "SCOPE_SWITCH",
      entity: "scope",
      entityId: ctx.homeTenantId,
      userName: ctx.name,
      details: "Returned to own scope",
      tenantId: ctx.homeTenantId,
    });
    return NextResponse.json({ success: true, activeTenantId: ctx.homeTenantId });
  }

  // SCOPE-EXEMPT: scope registry lookup, SUPER_ADMIN-gated.
  const target = await UNSAFE_unscopedPrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, name: true },
  });

  if (!target) {
    return NextResponse.json({ error: "Scope not found" }, { status: 404 });
  }

  await setViewScope(target.id);

  await logAudit({
    action: "SCOPE_SWITCH",
    entity: "scope",
    entityId: target.id,
    userName: ctx.name,
    details: `SUPER_ADMIN switched to scope "${target.name}" (${target.id})`,
    tenantId: ctx.homeTenantId,
  });

  return NextResponse.json({
    success: true,
    activeTenantId: target.id,
    activeScopeName: target.name,
  });
});
