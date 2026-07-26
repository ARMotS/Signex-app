import { NextRequest, NextResponse } from "next/server";
import { UNSAFE_unscopedPrisma } from "@/lib/db-scoped";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { createAdminAccount } from "@/lib/accounts";
import { logAudit } from "@/lib/audit";
import crypto from "crypto";

/**
 * GET /api/admin/users
 * Users inside the currently-active scope. For a SUPER_ADMIN using the scope
 * switcher, that is the scope being viewed.
 */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "SUPER_ADMIN");

  const users = await ctx.db.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ users });
});

/**
 * POST /api/admin/users
 * Create a new ADMIN — in a BRAND NEW scope of its own.
 *
 * This is the fix for the core isolation bug. The previous implementation used
 * `tenantId: ctx.tenantId`, so every ADMIN the SUPER_ADMIN created landed in the
 * SUPER_ADMIN's own tenant and all of them shared one pool of drivers, trip
 * sheets, contacts and OneDrive tokens. Correct `where: { tenantId }` filters
 * throughout the codebase isolated nothing, because the value was identical.
 *
 * A new ADMIN now owns a fresh Tenant, and everything they create inherits it.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "SUPER_ADMIN");

  const { name, email, password } = await request.json();

  if (!name || !email || !password) {
    return NextResponse.json(
      { error: "Name, email, and password are required" },
      { status: 400 }
    );
  }

  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 }
    );
  }

  const normalizedEmail = String(email).toLowerCase().trim();

  // SCOPE-EXEMPT: User.email and Admin.email are globally unique, so these
  // collision checks must span scopes. Only existence is used.
  const [existingUser, existingAdmin] = await Promise.all([
    UNSAFE_unscopedPrisma.user.findUnique({ where: { email: normalizedEmail } }),
    UNSAFE_unscopedPrisma.admin.findUnique({ where: { email: normalizedEmail } }),
  ]);

  if (existingUser || existingAdmin) {
    return NextResponse.json(
      { error: "A user with this email already exists" },
      { status: 400 }
    );
  }

  // Mint the new ADMIN's own isolation scope.
  const slug = `admin-${crypto.randomBytes(6).toString("hex")}`;
  const tenant = await UNSAFE_unscopedPrisma.tenant.create({
    data: { name: `${name}`, slug },
  });

  // createAdminAccount writes into the NEW tenant, not the caller's.
  const result = await createAdminAccount(name, normalizedEmail, password, tenant.id);
  if (!result.success) {
    // Roll back the empty scope so a failed creation leaves nothing behind.
    await UNSAFE_unscopedPrisma.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const user = await UNSAFE_unscopedPrisma.user.create({
    data: {
      email: normalizedEmail,
      name,
      role: "ADMIN",
      tenantId: tenant.id,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });

  // Record the ADMIN as the owner of the scope.
  await UNSAFE_unscopedPrisma.tenant.update({
    where: { id: tenant.id },
    data: { ownerAdminId: result.account!.id },
  });

  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "admin",
    entityId: result.account!.id,
    userName: ctx.name,
    details: `SUPER_ADMIN created ADMIN ${normalizedEmail} in new isolated scope ${tenant.id}`,
    tenantId: ctx.homeTenantId,
  });

  return NextResponse.json({
    user,
    scope: { tenantId: tenant.id, slug: tenant.slug },
  });
});
