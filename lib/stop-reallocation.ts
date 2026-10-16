/**
 * Reallocating stops from one driver's live run to another's.
 *
 * The case it exists for: a driver did not finish yesterday's run, and today
 * someone else has to — because the first driver is busy elsewhere, or absent.
 * The office picks the unsigned stops (one invoice or all of them) and the
 * driver to give them to.
 *
 * The Stop rows themselves move. A new ACTIVE trip sheet is created for the
 * receiving driver and the stops are re-pointed at it, renumbered 1..n in their
 * original order, carrying their collections and rejected lines with them. That
 * keeps one row per delivery — the signature, the confirmation email and the
 * archive all follow the stop wherever it goes — rather than copying a delivery
 * and having to keep two copies from both being signed.
 *
 * The receiving run shares the original's source filename. moveToProcessed is
 * idempotent (a file already in processed/ counts as archived), so whichever
 * of the two runs completes second still archives cleanly.
 *
 * A ReallocatedStop row is written per stop in the same transaction, read from
 * both ends: what left the original run and to whom, and where the receiving
 * run's stops came from. The original run can then be completed once whatever
 * is left on it is signed — even if nothing is.
 *
 * Signed stops never move: they were delivered by the driver they are on.
 * Neither does a stop with a collection that already has an outcome — the
 * goods (or the "not there" / "refused") are that driver's, not the next one's.
 */

import { scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";

export const REALLOCATION_REASON_MAX = 300;

/** Thrown inside the transaction to roll it back with a reason. */
class ReallocationConflict extends Error {}

/** A collection got an outcome while the move was in flight. */
class CollectionConflict extends Error {}

export type ReallocateResult =
  | {
      outcome: "reallocated";
      toTripSheetId: string;
      moved: number;
      toDriverName: string;
    }
  /** The trip, the target driver, or one of the stops is not in this scope. */
  | { outcome: "not_found"; what: "trip" | "driver" | "stop" }
  | { outcome: "same_driver" }
  | { outcome: "driver_inactive" }
  | { outcome: "nothing_selected" }
  /** A selected stop was signed (possibly a moment ago) — nothing was moved. */
  | { outcome: "signed"; invoiceNumbers: string[] }
  /** A selected stop has a collection already given an outcome — nothing moved. */
  | { outcome: "collected"; collectionNos: string[] };

export function normalizeReallocationReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim().slice(0, REALLOCATION_REASON_MAX) || null;
}

/** Vehicle registration for the receiving run; blank keeps the original's. */
export function normalizeRegNo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.replace(/\s+/g, " ").trim().toUpperCase().slice(0, 20) || null;
}

export async function reallocateStops(
  tenantId: string,
  input: {
    fromTripSheetId: string;
    stopIds: string[];
    toDriverId: string;
    reason: string | null;
    regNo: string | null;
    reallocatedBy: string;
  }
): Promise<ReallocateResult> {
  const db = scopedPrisma(tenantId);
  const stopIds = [...new Set(input.stopIds.filter((id) => typeof id === "string" && id))];
  if (stopIds.length === 0) return { outcome: "nothing_selected" };

  const trip = await db.tripSheet.findFirst({ where: { id: input.fromTripSheetId } });
  if (!trip) return { outcome: "not_found", what: "trip" };

  const [fromDriver, toDriver] = await Promise.all([
    db.driver.findFirst({ where: { id: trip.driverId }, select: { id: true, name: true } }),
    db.driver.findFirst({
      where: { id: input.toDriverId },
      select: { id: true, name: true, active: true },
    }),
  ]);
  // A driver id from another scope is simply not found.
  if (!toDriver) return { outcome: "not_found", what: "driver" };
  if (toDriver.id === trip.driverId) return { outcome: "same_driver" };
  if (!toDriver.active) return { outcome: "driver_inactive" };

  const stops = await db.stop.findMany({
    where: { id: { in: stopIds }, tripSheetId: trip.id },
    orderBy: { stopNumber: "asc" },
    select: {
      id: true,
      stopNumber: true,
      invoiceNumber: true,
      customerName: true,
      status: true,
      collections: { select: { collectionNo: true, status: true } },
    },
  });
  // Every id must be a stop on THIS run. One that is not — another run's,
  // another scope's, or already moved — fails the whole request rather than
  // silently moving a subset of what the dispatcher ticked.
  if (stops.length !== stopIds.length) return { outcome: "not_found", what: "stop" };

  const signed = stops.filter((s) => s.status === "SIGNED");
  if (signed.length > 0) {
    return { outcome: "signed", invoiceNumbers: signed.map((s) => s.invoiceNumber) };
  }

  // A collection with an outcome is the original driver's work: COLLECTED or
  // PARTIAL goods are on their truck, NOT_AVAILABLE / REFUSED is what they
  // found at the door, and the signed receipt is filed against their run.
  // Moving the stop would put all of that on another driver's run. Only a
  // stop whose collections are all still PENDING can move.
  const done = stops.flatMap((s) => s.collections.filter((c) => c.status !== "PENDING"));
  if (done.length > 0) {
    return { outcome: "collected", collectionNos: done.map((c) => c.collectionNo) };
  }
  const pendingCollections = stops.reduce((n, s) => n + s.collections.length, 0);

  let toTripSheetId: string;
  try {
    toTripSheetId = await db.$transaction(async (tx) => {
      const created = await tx.tripSheet.create({
        data: {
          sourceFilename: trip.sourceFilename,
          uploadedBy: input.reallocatedBy,
          driverId: toDriver.id,
          regNo: input.regNo ?? trip.regNo,
          adminId: trip.adminId,
          status: "ACTIVE",
        },
        select: { id: true },
      });

      for (const [i, stop] of stops.entries()) {
        // Conditional on the stop still being unsigned and still on the
        // original run. A driver signing at the door in the same moment makes
        // this match nothing, and the whole move rolls back.
        const moved = await tx.stop.updateMany({
          where: { id: stop.id, tripSheetId: trip.id, status: { not: "SIGNED" } },
          data: { tripSheetId: created.id, stopNumber: i + 1, status: "PENDING" },
        });
        if (moved.count !== 1) {
          throw new ReallocationConflict(stop.invoiceNumber);
        }
      }

      // Collections carry their own tripSheetId (composite FK to the run); it
      // must follow the stop, or the receiving driver's sync cursor and the
      // original run's completion guard would both read them in the wrong place.
      // Only still-PENDING ones: if a driver recorded an outcome since the
      // check above, the count falls short and the whole move rolls back.
      const movedCollections = await tx.collection.updateMany({
        where: { stopId: { in: stops.map((s) => s.id) }, status: "PENDING" },
        data: { tripSheetId: created.id },
      });
      if (movedCollections.count !== pendingCollections) {
        throw new CollectionConflict();
      }

      await tx.reallocatedStop.createMany({
        data: stops.map((stop, i) => ({
          fromTripSheetId: trip.id,
          toTripSheetId: created.id,
          fromDriverId: trip.driverId,
          fromDriverName: fromDriver?.name ?? "Unknown",
          toDriverId: toDriver.id,
          toDriverName: toDriver.name,
          fromStopNumber: stop.stopNumber,
          toStopNumber: i + 1,
          invoiceNumber: stop.invoiceNumber,
          customerName: stop.customerName,
          reason: input.reason,
          reallocatedBy: input.reallocatedBy,
        })),
      });

      return created.id;
    });
  } catch (err) {
    if (err instanceof ReallocationConflict) {
      return { outcome: "signed", invoiceNumbers: [err.message] };
    }
    if (err instanceof CollectionConflict) {
      const now = await db.collection.findMany({
        where: { stopId: { in: stops.map((s) => s.id) }, status: { not: "PENDING" } },
        select: { collectionNo: true },
      });
      return { outcome: "collected", collectionNos: now.map((c) => c.collectionNo) };
    }
    throw err;
  }

  await logAudit({
    action: "STATUS_CHANGE",
    entity: "trip_sheet",
    entityId: trip.id,
    userName: input.reallocatedBy,
    details: `${stops.length} stop(s) reallocated from ${fromDriver?.name ?? "Unknown"} to ${toDriver.name} (${stops
      .map((s) => s.invoiceNumber || `stop ${s.stopNumber}`)
      .join(", ")})${input.reason ? ` — ${input.reason}` : ""}`,
    tenantId,
  });

  return {
    outcome: "reallocated",
    toTripSheetId,
    moved: stops.length,
    toDriverName: toDriver.name,
  };
}
