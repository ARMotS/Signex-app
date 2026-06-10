import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/**
 * GET /api/auth/drivers
 * Public endpoint — returns active driver names and delivery counts for the select page.
 * No sensitive data exposed (no pinHash, no tenantId, no userId).
 */
export async function GET() {
  const drivers = await prisma.driver.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      active: true,
      tripSheets: {
        where: { status: "ACTIVE" },
        select: {
          stops: {
            select: { status: true },
          },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  const result = drivers.map((d) => {
    const activeSheet = d.tripSheets[0];
    const stopCount = activeSheet?.stops.length || 0;
    const signedCount = activeSheet?.stops.filter((s) => s.status === "SIGNED").length || 0;
    return {
      id: d.id,
      name: d.name,
      active: d.active,
      stopCount,
      signedCount,
    };
  });

  return NextResponse.json({ drivers: result });
}
