import { NextResponse } from "next/server";
import { getSessionContext } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { buildSyncCursor } from "@/lib/sync-cursor";
import { courierOverview } from "@/lib/courier-confirm";

/**
 * GET /api/sync — the change feed.
 *
 * Returns an opaque cursor describing the current state of the caller's data.
 * Clients poll this and refetch the real payload only when the cursor moves,
 * which keeps an idle tab costing one small indexed query instead of a full
 * trip-sheet-with-stops fetch.
 *
 * What each role sees is deliberately different:
 *   - a DRIVER's cursor covers only their own trip sheets and stops, so another
 *     driver signing does not wake their device;
 *   - an ADMIN's cursor covers the whole scope, because the dashboard is
 *     watching every driver's progress.
 *
 * The cursor is opaque on purpose. Clients must compare it for equality and
 * nothing else — its shape is free to change without a client release.
 */

/** Polled continuously; a cached response would defeat the entire mechanism. */
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  // The session context, not getScope(): this route needs only the scope id
  // (the cursor helpers take it first), and one session check per poll.
  // A COMPANY_ADMIN with no branch chosen — the one case getScope() refuses —
  // has no data to watch, but the poll still carries its session check, so it
  // gets a fixed cursor rather than a 403 the layout would read as an auth
  // problem.
  const ctx = await getSessionContext();
  if (ctx.role === "COMPANY_ADMIN" && !ctx.isViewingOtherScope) {
    return NextResponse.json(
      { cursor: "no-branch", attention: 0 },
      { headers: { "Cache-Control": "no-store, must-revalidate" } }
    );
  }
  const isDriver = ctx.role === "DRIVER";

  const [cursor, courier] = await Promise.all([
    buildSyncCursor(ctx.tenantId, {
      // For a driver session the session id IS the driver row id, so this needs
      // no extra lookup. Scoping to it is what stops one driver's activity from
      // waking every other device in the fleet.
      driverId: isDriver ? ctx.userId : undefined,
    }),
    // The office's Courier nav badge rides on this poll instead of a timer of
    // its own (it was /api/courier/attention, once a minute per tab). Every
    // other role here is office: a company admin with no branch chosen has
    // already been answered above. Recomputed every poll, not only when the
    // cursor moves — "no answer" is reached by the clock, not by a write.
    isDriver ? null : courierOverview(ctx.tenantId, new Date()),
  ]);

  return NextResponse.json(courier ? { ...cursor, attention: courier.attention } : cursor, {
    headers: {
      "Cache-Control": "no-store, must-revalidate",
    },
  });
});
