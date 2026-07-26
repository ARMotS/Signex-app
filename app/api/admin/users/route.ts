import { NextRequest, NextResponse } from "next/server";
import { UNSAFE_unscopedPrisma } from "@/lib/db-scoped";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import {
  createAdminAccount,
  updateAdminAccount,
  setAdminActive,
} from "@/lib/accounts";
import { logAudit } from "@/lib/audit";
import crypto from "crypto";

/**
 * GET /api/admin/users
 *
 * Every ADMIN in the installation, with the scope each one owns.
 *
 * This is the deliberate exception to scoping. Each ADMIN now lives in its own
 * tenant, so a scoped query here would show the SUPER_ADMIN only itself and the
 * console would be empty — which is exactly the regression this replaces. The
 * cross-scope read is safe because it is SUPER_ADMIN-gated and returns only
 * account metadata: no drivers, contacts, trip sheets or OneDrive details ever
 * cross a scope boundary through this endpoint.
 */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "SUPER_ADMIN");

  // SCOPE-EXEMPT: SUPER_ADMIN account-management console. Returns account
  // metadata across scopes by design; no scoped business data is included.
  const admins = await UNSAFE_unscopedPrisma.admin.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      active: true,
      createdAt: true,
      tenantId: true,
      tenant: {
        select: {
          id: true,
          name: true,
          slug: true,
          companyName: true,
          _count: { select: { drivers: true, contacts: true, tripSheets: true } },
        },
      },
    },
  });

  // Role lives on User, keyed by the same email.
  const users = await UNSAFE_unscopedPrisma.user.findMany({
    select: { id: true, email: true, role: true },
  });
  const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u]));

  const rows = admins.map((a) => {
    const u = userByEmail.get(a.email.toLowerCase());
    return {
      // The Users page acts on the Admin row; expose that as the id.
      id: a.id,
      userId: u?.id ?? null,
      name: a.name,
      email: a.email,
      role: u?.role ?? "ADMIN",
      active: a.active,
      createdAt: a.createdAt,
      isSelf: a.id === ctx.userId,
      scope: {
        tenantId: a.tenantId,
        slug: a.tenant?.slug ?? null,
        companyName: a.tenant?.companyName ?? a.tenant?.name ?? null,
        isRoot: a.tenantId === ctx.homeTenantId,
        counts: a.tenant?._count ?? { drivers: 0, contacts: 0, tripSheets: 0 },
      },
    };
  });

  return NextResponse.json({ users: rows });
});

/**
 * POST /api/admin/users/active is not a route in Next's file router, so
 * activation is folded into PUT here.
 *
 * PUT /api/admin/users
 * Body: { id: string, active: boolean }
 * Deactivate or reactivate an ADMIN. Their drivers are unaffected.
 */
export const PUT = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "SUPER_ADMIN");

  const { id, active } = await request.json();

  if (!id || typeof active !== "boolean") {
    return NextResponse.json(
      { error: "id and active (boolean) are required" },
      { status: 400 }
    );
  }

  if (id === ctx.userId) {
    return NextResponse.json(
      { error: "You cannot deactivate your own account" },
      { status: 400 }
    );
  }

  // SCOPE-EXEMPT: SUPER_ADMIN account management; the target is addressed by
  // primary key and only its active flag is read here.
  const target = await UNSAFE_unscopedPrisma.admin.findUnique({
    where: { id },
    select: { id: true, email: true },
  });
  if (!target) {
    return NextResponse.json({ error: "Admin not found" }, { status: 404 });
  }

  // Never deactivate the last active SUPER_ADMIN, or nobody can administer.
  if (!active) {
    const targetUser = await UNSAFE_unscopedPrisma.user.findUnique({
      where: { email: target.email.toLowerCase() },
      select: { role: true },
    });
    if (targetUser?.role === "SUPER_ADMIN") {
      const superEmails = (
        await UNSAFE_unscopedPrisma.user.findMany({
          where: { role: "SUPER_ADMIN" },
          select: { email: true },
        })
      ).map((u) => u.email.toLowerCase());
      const activeSupers = await UNSAFE_unscopedPrisma.admin.count({
        where: { active: true, email: { in: superEmails } },
      });
      if (activeSupers <= 1) {
        return NextResponse.json(
          { error: "Cannot deactivate the last active super admin" },
          { status: 400 }
        );
      }
    }
  }

  const result = await setAdminActive(id, active, ctx.name);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true, active });
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

  const { name, email, password, companyName } = await request.json();

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
    // companyName is what drivers see in the sign-in picker. Defaults to the
    // admin's name; the SUPER_ADMIN can rename it from the Users page.
    data: { name: `${name}`, slug, companyName: companyName?.trim() || name },
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
/**
 * PATCH /api/admin/users
 * Body: { id: <Admin.id>, name?, email?, password?, role? }
 *
 * Edit an ADMIN account. Addressed by Admin.id across scopes, matching what the
 * Users console lists — each ADMIN owns its own tenant, so a scoped lookup would
 * find nothing. SUPER_ADMIN-gated, and only account fields are touched; no
 * scoped business data is read or written.
 */
export const PATCH = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "SUPER_ADMIN");

  const { id, name, email, password, role } = await request.json();

  if (!id) {
    return NextResponse.json({ error: "Admin ID is required" }, { status: 400 });
  }

  // SCOPE-EXEMPT: SUPER_ADMIN account management. Addressed by primary key.
  const target = await UNSAFE_unscopedPrisma.admin.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, tenantId: true },
  });
  if (!target) {
    return NextResponse.json({ error: "Admin not found" }, { status: 404 });
  }

  const targetUser = await UNSAFE_unscopedPrisma.user.findUnique({
    where: { email: target.email.toLowerCase() },
    select: { id: true, role: true },
  });

  const isSelf = target.id === ctx.userId;

  // Validate role change
  let newRole = targetUser?.role ?? "ADMIN";
  if (role !== undefined && role !== newRole) {
    if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    if (isSelf) {
      return NextResponse.json(
        { error: "You cannot change your own role" },
        { status: 400 }
      );
    }
    // Never demote the last super admin, or nobody can administer.
    if (newRole === "SUPER_ADMIN" && role !== "SUPER_ADMIN") {
      const supers = await UNSAFE_unscopedPrisma.user.count({
        where: { role: "SUPER_ADMIN" },
      });
      if (supers <= 1) {
        return NextResponse.json(
          { error: "Cannot demote the last super admin" },
          { status: 400 }
        );
      }
    }
    newRole = role;
  }

  if (password !== undefined && password !== "" && password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 }
    );
  }

  const newEmail =
    email !== undefined && email !== ""
      ? String(email).toLowerCase().trim()
      : target.email;

  if (newEmail !== target.email) {
    // SCOPE-EXEMPT: Admin.email and User.email are globally unique, so a rename
    // must not collide with an account in another scope. Existence only.
    const [clashAdmin, clashUser] = await Promise.all([
      UNSAFE_unscopedPrisma.admin.findUnique({
        where: { email: newEmail },
        select: { id: true },
      }),
      UNSAFE_unscopedPrisma.user.findUnique({
        where: { email: newEmail },
        select: { id: true },
      }),
    ]);
    if (
      (clashAdmin && clashAdmin.id !== target.id) ||
      (clashUser && clashUser.id !== targetUser?.id)
    ) {
      return NextResponse.json(
        { error: "A user with this email already exists" },
        { status: 400 }
      );
    }
  }

  // The credential row lives in the ADMIN's own scope.
  const adminResult = await updateAdminAccount(target.tenantId, target.email, {
    name,
    email: newEmail,
    password,
  });
  if (!adminResult.success) {
    return NextResponse.json({ error: adminResult.error }, { status: 400 });
  }

  if (targetUser) {
    await UNSAFE_unscopedPrisma.user.update({
      where: { id: targetUser.id },
      data: {
        ...(name !== undefined && { name }),
        email: newEmail,
        role: newRole,
      },
    });
  }

  // Keep the scope's label in step with the admin's name.
  if (name !== undefined) {
    await UNSAFE_unscopedPrisma.tenant.updateMany({
      where: { ownerAdminId: target.id },
      data: { name },
    });
  }

  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "admin",
    entityId: target.id,
    userName: ctx.name,
    details: `Admin updated: ${newEmail}`,
    tenantId: target.tenantId,
  });

  return NextResponse.json({
    user: {
      id: target.id,
      name: name ?? target.name,
      email: newEmail,
      role: newRole,
    },
  });
});

/**
 * DELETE /api/admin/users
 * Body: { id: <Admin.id>, deleteScopeData?: boolean }
 *
 * Delete an ADMIN and the scope they own.
 *
 * Refuses by default when their scope still holds drivers, contacts or trip
 * sheets: deleting the ADMIN would otherwise strand that data where nothing but
 * the scope switcher can reach it. Deactivation is the reversible option and is
 * what the 409 points at. Pass deleteScopeData: true to delete the workspace and
 * everything in it.
 */
export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "SUPER_ADMIN");

  const { id, deleteScopeData } = await request.json();

  if (!id) {
    return NextResponse.json({ error: "Admin ID is required" }, { status: 400 });
  }

  if (id === ctx.userId) {
    return NextResponse.json(
      { error: "You cannot delete your own account" },
      { status: 400 }
    );
  }

  // SCOPE-EXEMPT: SUPER_ADMIN account management. Addressed by primary key.
  const target = await UNSAFE_unscopedPrisma.admin.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      tenantId: true,
      tenant: {
        select: {
          id: true,
          slug: true,
          _count: {
            select: { drivers: true, contacts: true, tripSheets: true },
          },
        },
      },
    },
  });
  if (!target) {
    return NextResponse.json({ error: "Admin not found" }, { status: 404 });
  }

  const targetUser = await UNSAFE_unscopedPrisma.user.findUnique({
    where: { email: target.email.toLowerCase() },
    select: { id: true, role: true },
  });

  // Never delete the last super admin.
  if (targetUser?.role === "SUPER_ADMIN") {
    const supers = await UNSAFE_unscopedPrisma.user.count({
      where: { role: "SUPER_ADMIN" },
    });
    if (supers <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last super admin" },
        { status: 400 }
      );
    }
  }

  const counts = target.tenant?._count ?? {
    drivers: 0,
    contacts: 0,
    tripSheets: 0,
  };
  const hasData = counts.drivers + counts.contacts + counts.tripSheets > 0;

  if (hasData && !deleteScopeData) {
    return NextResponse.json(
      {
        error:
          "This admin's workspace still contains data. Deactivate them instead, " +
          "or confirm deletion of the workspace and everything in it.",
        requiresConfirmation: true,
        counts,
      },
      { status: 409 }
    );
  }

  const tenantId = target.tenantId;
  const isRootScope = tenantId === ctx.homeTenantId;

  await UNSAFE_unscopedPrisma.$transaction(async (tx) => {
    if (hasData && deleteScopeData) {
      // Order matters: Stop is Restrict-referenced to Contact, and TripSheet
      // cascades to Stop, so stops and sheets go before contacts and drivers.
      await tx.stop.deleteMany({ where: { tenantId } });
      await tx.tripSheet.deleteMany({ where: { tenantId } });
      await tx.contact.deleteMany({ where: { tenantId } });
      await tx.driver.deleteMany({ where: { tenantId } });
      await tx.importedFile.deleteMany({ where: { tenantId } });
      await tx.cloudAccount.deleteMany({ where: { tenantId } });
      await tx.appConfig.deleteMany({ where: { tenantId } });
    }

    if (targetUser) {
      await tx.user.delete({ where: { id: targetUser.id } });
    }

    // Release the ownership pointer before removing the Admin it references.
    await tx.tenant.updateMany({
      where: { ownerAdminId: target.id },
      data: { ownerAdminId: null },
    });

    await tx.admin.delete({ where: { id: target.id } });

    // Drop the now-empty scope, unless it is the root scope or still shared.
    if (!isRootScope) {
      const remainingAdmins = await tx.admin.count({ where: { tenantId } });
      const remainingUsers = await tx.user.count({ where: { tenantId } });
      if (remainingAdmins === 0 && remainingUsers === 0) {
        // AuditLog.tenantId is nullable by design; detach rather than delete so
        // the trail of what happened in that scope survives.
        await tx.auditLog.updateMany({
          where: { tenantId },
          data: { tenantId: null },
        });
        await tx.tenant.delete({ where: { id: tenantId } });
      }
    }
  });

  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "admin",
    entityId: target.id,
    userName: ctx.name,
    details: `Admin deleted: ${target.email}${
      hasData && deleteScopeData
        ? ` (workspace purged: ${counts.drivers} drivers, ${counts.contacts} contacts, ${counts.tripSheets} trip sheets)`
        : ""
    }`,
    tenantId: ctx.homeTenantId,
  });

  return NextResponse.json({ success: true });
});
