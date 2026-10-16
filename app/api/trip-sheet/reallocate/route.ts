import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import {
  normalizeReallocationReason,
  normalizeRegNo,
  reallocateStops,
} from "@/lib/stop-reallocation";

/** Upper bound on one request; a run is a few dozen stops. */
const MAX_STOPS = 500;

/**
 * Move unsigned stops from one driver's active run to another driver.
 *
 * Body: { tripSheetId, stopIds[], toDriverId, reason?, regNo? }. ADMIN only.
 * Every id is resolved on the scoped client, so a trip, stop or driver from
 * another scope is 404 — never 403. See lib/stop-reallocation.ts.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json().catch(() => ({}));
  const { tripSheetId, stopIds, toDriverId } = body ?? {};
  if (typeof tripSheetId !== "string" || !tripSheetId) {
    return NextResponse.json({ error: "tripSheetId is required" }, { status: 400 });
  }
  if (typeof toDriverId !== "string" || !toDriverId) {
    return NextResponse.json({ error: "Choose the driver to reallocate to" }, { status: 400 });
  }
  if (!Array.isArray(stopIds) || stopIds.length > MAX_STOPS) {
    return NextResponse.json({ error: "stopIds must be a list of stops" }, { status: 400 });
  }

  const result = await reallocateStops(ctx.tenantId, {
    fromTripSheetId: tripSheetId,
    stopIds,
    toDriverId,
    reason: normalizeReallocationReason(body.reason),
    regNo: normalizeRegNo(body.regNo),
    reallocatedBy: ctx.name,
  });

  switch (result.outcome) {
    case "reallocated":
      return NextResponse.json({ success: true, ...result });
    case "not_found":
      return NextResponse.json(
        {
          error:
            result.what === "driver"
              ? "Driver not found"
              : result.what === "trip"
              ? "Trip sheet not found"
              : "One of the selected stops is no longer on this trip sheet — refresh and try again",
        },
        { status: 404 }
      );
    case "nothing_selected":
      return NextResponse.json({ error: "Select at least one stop to reallocate" }, { status: 400 });
    case "same_driver":
      return NextResponse.json(
        { error: "Choose a different driver — these stops are already theirs" },
        { status: 400 }
      );
    case "driver_inactive":
      return NextResponse.json({ error: "That driver is deactivated" }, { status: 409 });
    case "signed":
      return NextResponse.json(
        {
          error: `Already signed, so it stays with its driver: ${result.invoiceNumbers.join(", ")}. Nothing was moved.`,
          code: "STOP_SIGNED",
        },
        { status: 409 }
      );
  }
});
