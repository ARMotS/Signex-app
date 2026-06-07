import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/auth/drivers
 * Public endpoint — returns active driver names for the select page.
 * No sensitive data exposed (no pinHash, no tenantId, no userId).
 */
export async function GET() {
  const drivers = await prisma.driver.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      active: true,
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ drivers });
}
