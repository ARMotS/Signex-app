import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import {
  createDriverAccount,
  updateDriver,
  deleteDriver,
} from "@/lib/accounts";

export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  // Scoped client — this list can only ever contain this ADMIN's own drivers.
  const drivers = await ctx.db.driver.findMany({
    select: {
      id: true,
      name: true,
      active: true,
      createdAt: true,
    },
    orderBy: { name: "asc" },
  });

  // The sign-in link this ADMIN gives their drivers. The slug is a random token,
  // and there is no public directory of operators, so holding the link is what
  // grants sight of these driver names.
  const scope = await ctx.db.tenant.findFirst({
    where: { id: ctx.tenantId },
    select: { slug: true, companyName: true, name: true },
  });

  return NextResponse.json({
    drivers,
    signInLink: scope
      ? {
          slug: scope.slug,
          path: `/select/${scope.slug}`,
          companyName: scope.companyName || scope.name || null,
        }
      : null,
  });
});

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
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
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { id, ...updates } = await request.json();

  if (!id) {
    return NextResponse.json(
      { error: "Driver ID is required" },
      { status: 400 }
    );
  }

  // Scoped read — a driver in another ADMIN's scope is not found (404, not 403,
  // so the id's existence elsewhere is not disclosed).
  const driver = await ctx.db.driver.findFirst({ where: { id } });
  if (!driver) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  const result = await updateDriver(ctx.tenantId, id, updates);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { id } = await request.json();

  if (!id) {
    return NextResponse.json(
      { error: "Driver ID is required" },
      { status: 400 }
    );
  }

  const driver = await ctx.db.driver.findFirst({ where: { id } });
  if (!driver) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  const result = await deleteDriver(ctx.tenantId, id);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
});
