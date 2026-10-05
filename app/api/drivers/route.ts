import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import {
  createDriverAccount,
  listDrivers,
  updateDriver,
  deleteDriver,
} from "@/lib/accounts";
import { USERNAME_TAKEN } from "@/lib/credentials";

/** A taken username is a conflict the form shows inline; anything else is a 400. */
function errorStatus(error: string | undefined): number {
  return error === USERNAME_TAKEN ? 409 : 400;
}

export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  // Scoped — this list can only ever contain this ADMIN's own drivers.
  // `canSignIn` is false for drivers created before usernames existed; the
  // page lists them so the ADMIN can set their credentials.
  const drivers = await listDrivers(ctx.tenantId);

  return NextResponse.json({
    drivers,
    withoutLogin: drivers.filter((d) => !d.canSignIn).length,
  });
});

/**
 * POST /api/drivers
 * Body: { name, username, password }
 *
 * Always creates in the caller's own scope (or, for a SUPER_ADMIN, the scope
 * they are viewing) — the tenant comes from the session, never the body.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { name, username, password } = await request.json();

  if (!name || !username || !password) {
    return NextResponse.json(
      { error: "Name, username and password are required" },
      { status: 400 }
    );
  }

  const result = await createDriverAccount(
    String(name).trim(),
    username,
    password,
    ctx.tenantId
  );
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: errorStatus(result.error) });
  }

  return NextResponse.json({ success: true, driver: result.account });
});

/**
 * PUT /api/drivers
 * Body: { id, name?, active?, username?, password? }
 *
 * Setting `password` is a reset: the driver is signed out at once.
 */
export const PUT = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { id, name, active, username, password } = await request.json();

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

  // Only the fields this route manages are passed through.
  const result = await updateDriver(ctx.tenantId, id, {
    ...(typeof name === "string" && { name: name.trim() }),
    ...(typeof active === "boolean" && { active }),
    ...(typeof username === "string" && { username }),
    ...(typeof password === "string" && { password }),
  });
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: errorStatus(result.error) });
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
