import { NextRequest, NextResponse } from "next/server";
import { getCompletedTripSheets } from "@/lib/trip-data";
import { dayWindow, parseTzOffset } from "@/lib/day-window";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * Trip sheets closed out today, for the "Completed Today" tab.
 *
 * Reads the archive written by completeTripSheet, not live trip sheets — a
 * completed sheet no longer exists as a TripSheet row. See the CompletedTripSheet
 * model in prisma/schema.prisma for why.
 *
 * `?tzOffset=` scopes "today" to the dispatcher's own clock; `?range=all`
 * shows the whole archive instead.
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);
  const offsetMinutes = parseTzOffset(searchParams.get("tzOffset"));
  const allTime = searchParams.get("range") === "all";

  const day = dayWindow(new Date(), offsetMinutes);

  const completed = await getCompletedTripSheets(
    ctx.tenantId,
    allTime ? { limit: 200 } : { since: day.start, until: day.end, limit: 200 }
  );

  const stopsDelivered = completed.reduce((sum, c) => sum + c.signedStops, 0);

  return NextResponse.json({
    completed,
    range: allTime ? "all" : "today",
    dayStart: day.start.toISOString(),
    dayEnd: day.end.toISOString(),
    count: completed.length,
    stopsDelivered,
  });
});
