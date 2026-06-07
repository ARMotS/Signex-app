import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
  requireRole(ctx, "SUPER_ADMIN");

  const { tenantName, tenantSlug, adminEmail, adminName } = await request.json();

  if (!tenantName || !tenantSlug || !adminEmail || !adminName) {
    return NextResponse.json(
      { error: "tenantName, tenantSlug, adminEmail, and adminName are required" },
      { status: 400 }
    );
  }

  const existingSlug = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
  });

  if (existingSlug) {
    return NextResponse.json(
      { error: "A tenant with this slug already exists" },
      { status: 400 }
    );
  }

  const existingEmail = await prisma.user.findUnique({
    where: { email: adminEmail.toLowerCase() },
  });

  if (existingEmail) {
    return NextResponse.json(
      { error: "A user with this email already exists" },
      { status: 400 }
    );
  }

  const [tenant, user] = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: { name: tenantName, slug: tenantSlug },
    });

    const user = await tx.user.create({
      data: {
        email: adminEmail.toLowerCase(),
        name: adminName,
        role: "ADMIN",
        tenantId: tenant.id,
      },
    });

    return [tenant, user] as const;
  });

  return NextResponse.json({ tenant, user });
});
