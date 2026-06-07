import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const POST = withAuth(async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { id } = await params;
  const { email } = await request.json();

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }

  const driver = await prisma.driver.findUnique({ where: { id } });
  if (!driver || driver.tenantId !== ctx.tenantId) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  // Find or create User with DRIVER role in same tenant
  let user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  if (user) {
    if (user.tenantId !== ctx.tenantId) {
      return NextResponse.json(
        { error: "This email belongs to a different organization" },
        { status: 400 }
      );
    }
  } else {
    user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        name: driver.name,
        role: "DRIVER",
        tenantId: ctx.tenantId,
      },
    });
  }

  // Link driver to user
  await prisma.driver.update({
    where: { id },
    data: { userId: user.id },
  });

  return NextResponse.json({
    success: true,
    driver: { id: driver.id, name: driver.name, userId: user.id, email: user.email },
  });
});
