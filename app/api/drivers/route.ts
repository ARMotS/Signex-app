import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import {
  createDriverAccount,
  updateDriver,
  deleteDriver,
} from "@/lib/accounts";

export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const drivers = await prisma.driver.findMany({
    where: { tenantId: ctx.tenantId },
    select: {
      id: true,
      name: true,
      active: true,
      createdAt: true,
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ drivers });
});

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { name, pin } = await request.json();

  if (!name || !pin) {
    return NextResponse.json(
      { error: "Name and PIN are required" },
      { status: 400 }
    );
  }

  const result = await createDriverAccount(name, pin, ctx.tenantId);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true, driver: result.account });
});

export const PUT = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { id, ...updates } = await request.json();

  if (!id) {
    return NextResponse.json(
      { error: "Driver ID is required" },
      { status: 400 }
    );
  }

  // Verify driver belongs to this tenant
  const driver = await prisma.driver.findUnique({ where: { id } });
  if (!driver || driver.tenantId !== ctx.tenantId) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  const result = await updateDriver(id, updates);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { id } = await request.json();

  if (!id) {
    return NextResponse.json(
      { error: "Driver ID is required" },
      { status: 400 }
    );
  }

  // Verify driver belongs to this tenant
  const driver = await prisma.driver.findUnique({ where: { id } });
  if (!driver || driver.tenantId !== ctx.tenantId) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  const result = await deleteDriver(id);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
});
