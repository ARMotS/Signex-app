import { NextRequest, NextResponse } from "next/server";
import { UNSAFE_unscopedPrisma } from "@/lib/db-scoped";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const POST = withAuth(async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { id } = await params;
  const { email } = await request.json();

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const driver = await ctx.db.driver.findFirst({ where: { id } });
  if (!driver) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  // SCOPE-EXEMPT: User.email is globally unique, so this collision check must
  // span scopes. Only the boolean outcome is used — if the email belongs to
  // another scope the request is refused without revealing which.
  const existingUser = await UNSAFE_unscopedPrisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true, tenantId: true },
  });

  let user: { id: string; email: string };

  if (existingUser) {
    if (existingUser.tenantId !== ctx.tenantId) {
      return NextResponse.json(
        { error: "This email is already in use" },
        { status: 400 }
      );
    }
    user = { id: existingUser.id, email: existingUser.email };
  } else {
    user = await ctx.db.user.create({
      data: {
        email: email.toLowerCase(),
        name: driver.name,
        role: "DRIVER",
      },
      select: { id: true, email: true },
    });
  }

  // Link driver to user — scoped, so this can only touch our own driver row.
  await ctx.db.driver.update({
    where: { id },
    data: { userId: user.id },
  });

  return NextResponse.json({
    success: true,
    driver: { id: driver.id, name: driver.name, userId: user.id, email: user.email },
  });
});
