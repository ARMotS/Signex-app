import { NextRequest, NextResponse } from "next/server";
import { getCompletedTripSheets } from "@/lib/trip-data";
import {
  reportWindow,
  parseReportRange,
  parseTzOffset,
  localDateKey,
} from "@/lib/day-window";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * Completed trips broken down by day and by driver, over a day, calendar week
 * or calendar month.
 *
 * Separate from `/api/dashboard` on purpose: that endpoint is polled by the
 * live-sync hook all day, and a month's aggregation has no business running
 * every few seconds. This one is fetched only when the Completed tab is open
 * and the filters change.
 *
 * Reads the CompletedTripSheet archive rather than live trip sheets —
 * completing a sheet deletes it. See prisma/schema.prisma.
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);
  const offsetMinutes = parseTzOffset(searchParams.get("tzOffset"));
  const range = parseReportRange(searchParams.get("range"));
  const driverFilter = searchParams.get("driverId");

  const window = reportWindow(new Date(), offsetMinutes, range);

  // A month of completions for a busy depot is still a small number of rows —
  // one per closed-out sheet, not one per delivery.
  const [completed, roster] = await Promise.all([
    getCompletedTripSheets(ctx.tenantId, {
      since: window.start,
      until: window.end,
      limit: 500,
    }),
    ctx.db.driver.findMany({
      select: { id: true, name: true, active: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // The filter is applied after the read so the driver dropdown can still list
  // everyone who worked in the window, not just the one being looked at.
  const scoped = driverFilter
    ? completed.filter((c) => c.driverId === driverFilter)
    : completed;

  // ─── Per day ────────────────────────────────────────────────────────────
  // Every day in the window is present, including the empty ones: a gap is a
  // day nobody closed out, which is information, and dropping it would make a
  // quiet Tuesday look like it never happened.
  const dayBuckets = new Map<
    string,
    { sheets: number; deliveries: number; driverIds: Set<string> }
  >();
  for (const key of window.dayKeys) {
    dayBuckets.set(key, { sheets: 0, deliveries: 0, driverIds: new Set() });
  }

  const driverBuckets = new Map<
    string,
    {
      driverId: string;
      driverName: string;
      sheets: number;
      deliveries: number;
      dayKeys: Set<string>;
      lastCompletedAt: string | null;
    }
  >();

  for (const sheet of scoped) {
    const key = localDateKey(new Date(sheet.completedAt), window.offsetMinutes);

    const day = dayBuckets.get(key);
    if (day) {
      day.sheets += 1;
      day.deliveries += sheet.signedStops;
      day.driverIds.add(sheet.driverId);
    }

    const driver = driverBuckets.get(sheet.driverId) ?? {
      driverId: sheet.driverId,
      driverName: sheet.driverName,
      sheets: 0,
      deliveries: 0,
      dayKeys: new Set<string>(),
      lastCompletedAt: null,
    };
    driver.sheets += 1;
    driver.deliveries += sheet.signedStops;
    driver.dayKeys.add(key);
    const at = new Date(sheet.completedAt).toISOString();
    if (!driver.lastCompletedAt || at > driver.lastCompletedAt) {
      driver.lastCompletedAt = at;
    }
    driverBuckets.set(sheet.driverId, driver);
  }

  const byDay = window.dayKeys.map((key) => {
    const bucket = dayBuckets.get(key)!;
    return {
      date: key,
      sheets: bucket.sheets,
      deliveries: bucket.deliveries,
      drivers: bucket.driverIds.size,
    };
  });

  const byDriver = [...driverBuckets.values()]
    .map((d) => ({
      driverId: d.driverId,
      driverName: d.driverName,
      sheets: d.sheets,
      deliveries: d.deliveries,
      daysWorked: d.dayKeys.size,
      lastCompletedAt: d.lastCompletedAt,
    }))
    .sort((a, b) => b.deliveries - a.deliveries || a.driverName.localeCompare(b.driverName));

  const deliveries = byDriver.reduce((sum, d) => sum + d.deliveries, 0);
  const activeDayCount = byDay.filter((d) => d.sheets > 0).length;

  return NextResponse.json({
    range,
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    driverId: driverFilter || null,

    totals: {
      sheets: scoped.length,
      deliveries,
      drivers: byDriver.length,
      activeDays: activeDayCount,
      /** Across days that saw activity — an average over idle days is noise. */
      avgDeliveriesPerActiveDay:
        activeDayCount > 0 ? Math.round(deliveries / activeDayCount) : 0,
      busiestDay: byDay.reduce<{ date: string; deliveries: number } | null>(
        (best, d) =>
          d.deliveries > 0 && (!best || d.deliveries > best.deliveries)
            ? { date: d.date, deliveries: d.deliveries }
            : best,
        null
      ),
    },

    byDay,
    byDriver,

    /** Everyone selectable in the filter, so it does not empty out mid-look. */
    drivers: roster.map((d) => ({ id: d.id, name: d.name, active: d.active })),

    /** The individual sheets, newest first, for the detail list. */
    sheets: scoped.map((c) => ({
      id: c.id,
      driverId: c.driverId,
      driverName: c.driverName,
      regNo: c.regNo,
      sourceFilename: c.sourceFilename,
      completedAt: c.completedAt,
      completedBy: c.completedBy,
      totalStops: c.totalStops,
      signedStops: c.signedStops,
    })),
  });
});
