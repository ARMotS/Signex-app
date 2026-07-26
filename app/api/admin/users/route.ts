import { NextRequest, NextResponse } from "next/server";
import { UNSAFE_unscopedPrisma } from "@/lib/db-scoped";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import {
  createAdminAccount,
  updateAdminAccount,
  deleteAdminAccount,
} from "@/lib/accounts";
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

/**
 * PATCH /api/admin/users
 * Edit a user inside the currently-active scope.
 *
 * Scoping note: `ctx.db` is locked to the active scope, so a SUPER_ADMIN using
 * the scope switcher edits users in the scope they are viewing, and an id from
 * any other scope is simply not found (404). The `Admin` credential row is
 * updated through updateAdminAccount, which is scoped the same way.
 */
export const PATCH = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "SUPER_ADMIN");

  const { id, name, email, password, role } = await request.json();

  if (!id) {
    return NextResponse.json({ error: "User ID is required" }, { status: 400 });
  }

  // Scoped read — a user in another scope is indistinguishable from one that
  // does not exist.
  const target = await ctx.db.user.findFirst({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // The admin session id is the Admin.id — resolve the caller's email so we
  // can protect them against locking themselves out.
  const currentAdmin = await ctx.db.admin.findFirst({
    where: { id: ctx.userId },
    select: { email: true },
  });
  const isSelf =
    currentAdmin?.email?.toLowerCase() === target.email.toLowerCase();

  // Validate role change
  let newRole = target.role;
  if (role !== undefined && role !== target.role) {
    if (role !== "ADMIN" && role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }
    if (isSelf) {
      return NextResponse.json(
        { error: "You cannot change your own role" },
        { status: 400 }
      );
    }
    // Never demote the last super admin in this scope
    if (target.role === "SUPER_ADMIN" && role !== "SUPER_ADMIN") {
      const superAdmins = await ctx.db.user.count({
        where: { role: "SUPER_ADMIN" },
      });
      if (superAdmins <= 1) {
        return NextResponse.json(
          { error: "Cannot demote the last super admin" },
          { status: 400 }
        );
      }
    }
    newRole = role;
  }

  // Validate password (only when provided)
  if (password !== undefined && password !== "" && password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 }
    );
  }

  // Validate email uniqueness when changing.
  const newEmail =
    email !== undefined && email !== "" ? email.toLowerCase() : target.email;
  if (newEmail !== target.email) {
    // SCOPE-EXEMPT: User.email is globally unique, so a rename must not collide
    // with an account in another scope. Only existence is used; the other
    // scope's row is never returned or described.
    const existing = await UNSAFE_unscopedPrisma.user.findUnique({
      where: { email: newEmail },
      select: { id: true },
    });
    if (existing && existing.id !== target.id) {
      return NextResponse.json(
        { error: "A user with this email already exists" },
        { status: 400 }
      );
    }
  }

  // Update the credential row first (matched by the original email, scoped)
  const adminResult = await updateAdminAccount(ctx.tenantId, target.email, {
    name,
    email: newEmail,
    password,
  });
  if (!adminResult.success) {
    return NextResponse.json({ error: adminResult.error }, { status: 400 });
  }

  const user = await ctx.db.user.update({
    where: { id: target.id },
    data: {
      ...(name !== undefined && { name }),
      email: newEmail,
      role: newRole,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });

  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "admin",
    entityId: target.id,
    userName: ctx.name,
    details: `User updated: ${newEmail}`,
    tenantId: ctx.tenantId,
  });

  return NextResponse.json({ user });
});

/**
 * DELETE /api/admin/users
 * Delete a user inside the currently-active scope.
 */
export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "SUPER_ADMIN");

  const { id } = await request.json();

  if (!id) {
    return NextResponse.json({ error: "User ID is required" }, { status: 400 });
  }

  const target = await ctx.db.user.findFirst({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const currentAdmin = await ctx.db.admin.findFirst({
    where: { id: ctx.userId },
    select: { email: true },
  });
  const isSelf =
    currentAdmin?.email?.toLowerCase() === target.email.toLowerCase();

  if (isSelf) {
    return NextResponse.json(
      { error: "You cannot delete your own account" },
      { status: 400 }
    );
  }

  // Never delete the last super admin in this scope
  if (target.role === "SUPER_ADMIN") {
    const superAdmins = await ctx.db.user.count({
      where: { role: "SUPER_ADMIN" },
    });
    if (superAdmins <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last super admin" },
        { status: 400 }
      );
    }
  }

  // Remove the credential row (scoped, matched by email), then the user record.
  await deleteAdminAccount(ctx.tenantId, target.email);
  await ctx.db.user.delete({ where: { id: target.id } });

  await logAudit({
    action: "CONFIG_UPDATE",
    entity: "admin",
    entityId: target.id,
    userName: ctx.name,
    details: `User deleted: ${target.email}`,
    tenantId: ctx.tenantId,
  });

  return NextResponse.json({ success: true });
});
