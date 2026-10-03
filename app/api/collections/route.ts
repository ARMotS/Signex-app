import { NextRequest, NextResponse } from "next/server";
import type { CollectionStatus, CollectionType } from "@prisma/client";
import { listCollections } from "@/lib/trip-data";
import { dayWindow, parseTzOffset } from "@/lib/day-window";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * The dispatcher's collections view and the credit-return report accounts
 * reconciles from.
 *
 * Reads live collections AND the frozen entries in completed trips' archives —
 * see listCollections. A report that only saw live rows would go empty at the
 * end of every day, exactly when someone wants to reconcile it.
 *
 * Filters:
 *   ?type=CREDIT_RETURN|NON_CREDIT_UPLIFT
 *   ?status=PENDING|COLLECTED|PARTIAL|NOT_AVAILABLE|REFUSED
 *   ?exceptions=true            only PARTIAL / NOT_AVAILABLE / REFUSED
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD   on collectedAt, the moment it was closed
 *   ?range=today&tzOffset=      the caller's own day, not the server's
 *   ?driverId= / ?tripSheetId=
 *   ?includeArchived=false      outstanding work only
 */

const VALID_TYPES: CollectionType[] = ["CREDIT_RETURN", "NON_CREDIT_UPLIFT"];
const VALID_STATUSES: CollectionStatus[] = [
  "PENDING",
  "COLLECTED",
  "PARTIAL",
  "NOT_AVAILABLE",
  "REFUSED",
];

const EXCEPTION_STATUSES = new Set<string>(["PARTIAL", "NOT_AVAILABLE", "REFUSED"]);

/** A date-only query param, read as the start of that UTC day. */
function parseDate(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);

  const typeParam = searchParams.get("type");
  const statusParam = searchParams.get("status");

  if (typeParam && !VALID_TYPES.includes(typeParam as CollectionType)) {
    return NextResponse.json(
      { error: `Invalid type. Use: ${VALID_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  if (statusParam && !VALID_STATUSES.includes(statusParam as CollectionStatus)) {
    return NextResponse.json(
      { error: `Invalid status. Use: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  let since = parseDate(searchParams.get("from"));
  let until = parseDate(searchParams.get("to"));

  // "Today" belongs to whoever is looking at the screen. Same reporting window
  // as every other date-bounded view — see lib/day-window.ts.
  if (searchParams.get("range") === "today") {
    const day = dayWindow(new Date(), parseTzOffset(searchParams.get("tzOffset")));
    since = day.start;
    until = day.end;
  }

  // A `to` date is a day the user means to include, so the exclusive upper
  // bound is the following midnight rather than that day's 00:00.
  if (until && !searchParams.get("range")) {
    until = new Date(until.getTime() + 24 * 60 * 60 * 1000);
  }

  // A driverId from a query string is client-supplied: narrowed to this scope
  // before it is used, so a driver in another ADMIN's scope is simply not found.
  const driverIdParam = searchParams.get("driverId");
  let driverId: string | undefined;
  if (driverIdParam) {
    const driver = await ctx.db.driver.findFirst({
      where: { id: driverIdParam },
      select: { id: true },
    });
    if (!driver) {
      return NextResponse.json({ error: "Driver not found" }, { status: 404 });
    }
    driverId = driver.id;
  }

  const records = await listCollections(ctx.tenantId, {
    type: (typeParam as CollectionType) ?? undefined,
    status: (statusParam as CollectionStatus) ?? undefined,
    since,
    until,
    driverId,
    tripSheetId: searchParams.get("tripSheetId") ?? undefined,
    includeArchived: searchParams.get("includeArchived") !== "false",
    onlyCompleted: searchParams.get("onlyCompleted") === "true",
  });

  const filtered =
    searchParams.get("exceptions") === "true"
      ? records.filter((r) => EXCEPTION_STATUSES.has(r.status))
      : records;

  const counts = {
    total: filtered.length,
    pending: filtered.filter((r) => r.status === "PENDING").length,
    collected: filtered.filter((r) => r.status === "COLLECTED").length,
    partial: filtered.filter((r) => r.status === "PARTIAL").length,
    notAvailable: filtered.filter((r) => r.status === "NOT_AVAILABLE").length,
    refused: filtered.filter((r) => r.status === "REFUSED").length,
    creditReturns: filtered.filter((r) => r.type === "CREDIT_RETURN").length,
    uplifts: filtered.filter((r) => r.type === "NON_CREDIT_UPLIFT").length,
    exceptions: filtered.filter((r) => EXCEPTION_STATUSES.has(r.status)).length,
  };

  return NextResponse.json({
    collections: filtered,
    counts,
    from: since?.toISOString() ?? null,
    to: until?.toISOString() ?? null,
  });
});
