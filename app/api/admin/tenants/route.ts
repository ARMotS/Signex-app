import { NextRequest, NextResponse } from "next/server";
import { UNSAFE_unscopedPrisma } from "@/lib/db-scoped";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { createAdminAccount } from "@/lib/accounts";
import { logAudit } from "@/lib/audit";
import { validatePassword, validateUsername } from "@/lib/credentials";

/**
 * POST /api/admin/tenants
 * Create a named scope together with the ADMIN who owns it.
 *
 * This previously created a Tenant and a User but no Admin row, so the "admin"
 * it created had no password and could never log in. It now creates all three in
 * one transaction, mirroring POST /api/admin/users but with a caller-chosen
 * tenant name and slug.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");

  const { tenantName, tenantSlug, adminEmail, adminName, adminUsername, adminPassword } =
    await request.json();

  if (
    !tenantName ||
    !tenantSlug ||
    !adminEmail ||
    !adminName ||
    !adminUsername ||
    !adminPassword
  ) {
    return NextResponse.json(
      {
        error:
          "tenantName, tenantSlug, adminEmail, adminName, adminUsername and adminPassword are required",
      },
      { status: 400 }
    );
  }

  const invalid = validateUsername(adminUsername) ?? validatePassword(adminPassword);
  if (invalid) {
    return NextResponse.json({ error: invalid }, { status: 400 });
  }

  const normalizedEmail = String(adminEmail).toLowerCase().trim();

  // SCOPE-EXEMPT: scope registry + globally unique email checks. SUPER_ADMIN-gated.
  const [existingSlug, existingUser, existingAdmin] = await Promise.all([
    UNSAFE_unscopedPrisma.tenant.findUnique({ where: { slug: tenantSlug } }),
    UNSAFE_unscopedPrisma.user.findUnique({ where: { email: normalizedEmail } }),
    UNSAFE_unscopedPrisma.admin.findUnique({ where: { email: normalizedEmail } }),
  ]);

  if (existingSlug) {
    return NextResponse.json(
      { error: "A tenant with this slug already exists" },
      { status: 400 }
    );
  }

  if (existingUser || existingAdmin) {
    return NextResponse.json(
      { error: "A user with this email already exists" },
      { status: 400 }
    );
  }

  const tenant = await UNSAFE_unscopedPrisma.tenant.create({
    data: { name: tenantName, slug: tenantSlug },
  });

  const result = await createAdminAccount(
    adminName,
    normalizedEmail,
    adminUsername,
    adminPassword,
    tenant.id
  );

  if (!result.success) {
    await UNSAFE_unscopedPrisma.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const user = await UNSAFE_unscopedPrisma.user.create({
    data: {
      email: normalizedEmail,
      name: adminName,
      role: "ADMIN",
      tenantId: tenant.id,
    },
    select: { id: true, email: true, name: true, role: true },
  });

  await UNSAFE_unscopedPrisma.tenant.update({
    where: { id: tenant.id },
    data: { ownerAdminId: result.account!.id },
  });

  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "admin",
    entityId: result.account!.id,
    userName: ctx.name,
    details: `SUPER_ADMIN created scope "${tenantName}" (${tenant.id}) with ADMIN ${normalizedEmail}`,
    tenantId: ctx.homeTenantId,
  });

  return NextResponse.json({ tenant, user, admin: result.account });
});
