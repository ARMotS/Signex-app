import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import {
  createAdminAccount,
  updateAdminAccount,
  deleteAdminAccount,
} from "@/lib/accounts";

export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");

  const users = await prisma.user.findMany({
    where: { tenantId: ctx.tenantId },
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

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");

  const { name, email, password, role } = await request.json();

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

  const validRole = role === "ADMIN" ? "ADMIN" : "ADMIN";

  const existing = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (existing) {
    return NextResponse.json(
      { error: "A user with this email already exists" },
      { status: 400 }
    );
  }

  const result = await createAdminAccount(name, email, password);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      name,
      role: validRole,
      tenantId: ctx.tenantId,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ user });
});

export const PATCH = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");

  const { id, name, email, password, role } = await request.json();

  if (!id) {
    return NextResponse.json({ error: "User ID is required" }, { status: 400 });
  }

  // Target must belong to the caller's tenant
  const target = await prisma.user.findFirst({
    where: { id, tenantId: ctx.tenantId },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // The admin session id is the Admin.id — resolve the caller's email so we
  // can protect them against locking themselves out.
  const currentAdmin = await prisma.admin.findUnique({
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
    // Never demote the last super admin
    if (target.role === "SUPER_ADMIN" && role !== "SUPER_ADMIN") {
      const superAdmins = await prisma.user.count({
        where: { tenantId: ctx.tenantId, role: "SUPER_ADMIN" },
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

  // Validate email uniqueness when changing
  const newEmail =
    email !== undefined && email !== "" ? email.toLowerCase() : target.email;
  if (newEmail !== target.email) {
    const existing = await prisma.user.findUnique({ where: { email: newEmail } });
    if (existing && existing.id !== target.id) {
      return NextResponse.json(
        { error: "A user with this email already exists" },
        { status: 400 }
      );
    }
  }

  // Update the credential row first (matched by the original email)
  const adminResult = await updateAdminAccount(target.email, {
    name,
    email: newEmail,
    password,
  });
  if (!adminResult.success) {
    return NextResponse.json({ error: adminResult.error }, { status: 400 });
  }

  const user = await prisma.user.update({
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

  return NextResponse.json({ user });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");

  const { id } = await request.json();

  if (!id) {
    return NextResponse.json({ error: "User ID is required" }, { status: 400 });
  }

  const target = await prisma.user.findFirst({
    where: { id, tenantId: ctx.tenantId },
  });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const currentAdmin = await prisma.admin.findUnique({
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

  // Never delete the last super admin
  if (target.role === "SUPER_ADMIN") {
    const superAdmins = await prisma.user.count({
      where: { tenantId: ctx.tenantId, role: "SUPER_ADMIN" },
    });
    if (superAdmins <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last super admin" },
        { status: 400 }
      );
    }
  }

  // Remove the credential row (matched by email), then the user record.
  await deleteAdminAccount(target.email);
  await prisma.user.delete({ where: { id: target.id } });

  return NextResponse.json({ success: true });
});