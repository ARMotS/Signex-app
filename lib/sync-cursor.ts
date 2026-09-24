/**
 * Change-feed cursor.
 *
 * Clients poll for a cheap stamp describing the current state of their data and
 * refetch the real payload only when it moves. An idle tab therefore costs two
 * indexed aggregates rather than a full trip-sheet-with-stops read — which is
 * what makes polling affordable for a hundred drivers at once.
 *
 * ── Why a timestamp alone is not enough ───────────────────────────────────
 * MAX(updatedAt) misses deletions. Completing a trip sheet removes it and
 * cascades its stops away; none of that advances a maximum, and it can even
 * move it BACKWARDS when the newest row is the one deleted. A driver would sit
 * looking at stops that no longer exist.
 *
 * Pairing the maximum with a COUNT closes it:
 *   - a create or update advances the maximum;
 *   - a delete changes the count;
 *   - a delete of the newest row changes both.
 *
 * `updatedAt` is maintained by Prisma's @updatedAt and only ever moves forward
 * on write, so a state the client has already seen cannot reproduce a cursor it
 * has already seen.
 */

import { scopedPrisma } from "./db-scoped";

export interface SyncCursor {
  /**
   * Opaque. Clients MUST compare it for equality and nothing else — the shape
   * is free to change without a client release.
   */
  cursor: string;
  /** Number of trip sheets in view. Exposed for UI, not for change detection. */
  tripSheets: number;
  /** Number of stops in view. */
  stops: number;
  /** Number of collections in view. */
  collections: number;
}

interface TableStamp {
  max: Date | null;
  count: number;
}

/**
 * Pure formatting, split out so the cursor rules can be tested without a
 * database.
 *
 * Collections are a third table in the stamp rather than folded into the stop
 * one. A driver recording a collection outcome does not touch the stop row, so
 * without this the run sheet would keep showing a collection as outstanding —
 * and on another device, a collection an office correction had changed. The
 * cursor is opaque, so widening it needs no client release.
 */
export function formatCursor(
  tripSheets: TableStamp,
  stops: TableStamp,
  collections: TableStamp
): string {
  const stamp = (t: TableStamp) => `${t.max ? t.max.getTime() : 0}.${t.count}`;
  return `${stamp(tripSheets)}-${stamp(stops)}-${stamp(collections)}`;
}

/**
 * Build the cursor for one scope.
 *
 * @param tenantId The caller's scope. Required, as everywhere in lib/.
 * @param opts.driverId When set, narrows to that driver's own trip sheets and
 *   stops. Passing it for a DRIVER session is what stops one driver's signature
 *   from waking every other device in the fleet.
 */
export async function buildSyncCursor(
  tenantId: string,
  opts: { driverId?: string } = {}
): Promise<SyncCursor> {
  const db = scopedPrisma(tenantId);
  const { driverId } = opts;

  const [sheetAgg, stopAgg, collectionAgg] = await Promise.all([
    db.tripSheet.aggregate({
      where: driverId ? { driverId } : {},
      _max: { updatedAt: true },
      _count: true,
    }),
    db.stop.aggregate({
      // Filtering through the relation is safe across the scope boundary: the
      // composite foreign key makes a stop pointing at another scope's trip
      // sheet unrepresentable, and the scoped client has already constrained
      // the top level to this tenant.
      where: driverId ? { tripSheet: { driverId } } : {},
      _max: { updatedAt: true },
      _count: true,
    }),
    db.collection.aggregate({
      // Narrowed through the trip sheet, not through Collection.driverId: that
      // column records who COLLECTED and is null until someone has, so keying
      // on it would leave every outstanding collection out of the driver's own
      // cursor — the exact rows they are polling for.
      where: driverId ? { tripSheet: { driverId } } : {},
      _max: { updatedAt: true },
      _count: true,
    }),
  ]);

  const tripSheets: TableStamp = {
    max: sheetAgg._max.updatedAt,
    count: sheetAgg._count,
  };
  const stops: TableStamp = {
    max: stopAgg._max.updatedAt,
    count: stopAgg._count,
  };
  const collections: TableStamp = {
    max: collectionAgg._max.updatedAt,
    count: collectionAgg._count,
  };

  return {
    cursor: formatCursor(tripSheets, stops, collections),
    tripSheets: tripSheets.count,
    stops: stops.count,
    collections: collections.count,
  };
}
