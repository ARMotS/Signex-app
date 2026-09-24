/**
 * Trip sheet data — PostgreSQL via Prisma.
 * Each trip sheet is assigned to a specific driver and contains stops.
 * Operations include eager loading of related stops.
 *
 * Every function takes `tenantId` as its first argument and it is REQUIRED.
 * It used to be optional on the read paths, which meant an omitted argument
 * silently returned every tenant's data.
 */

import { scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import { StopStatus as PrismaStopStatus } from "@prisma/client";
import type {
  CollectionStatus,
  CollectionType,
  UpliftSubtype,
} from "@prisma/client";
import { isTerminalStatus } from "./collections";
import { moveToProcessed } from "./trip-sheet-folder";
import { mapWithConcurrency } from "./concurrency";

export type StopStatus = "PENDING" | "IN_PROGRESS" | "SIGNED";

/**
 * One collection hanging off a stop.
 *
 * A collection is the mirror image of a delivery: goods going back with the
 * driver, signed for the same way. It lives on the stop rather than beside it
 * so a driver sees one visit to one address with two lists — Deliveries and
 * Collections — instead of two unrelated jobs at the same place.
 */
export interface TripCollection {
  id: string;
  collectionNo: string;
  type: CollectionType;
  upliftSubtype?: UpliftSubtype | null;
  notes?: string | null;
  originalInvoiceNo?: string | null;
  status: CollectionStatus | string;
  exceptionReason?: string | null;
  expectedQty?: number | null;
  collectedQty?: number | null;
  /** The pending document matched out of Collections/Pending, if any */
  sourceFileId?: string | null;
  sourceFilePath?: string | null;
  /** The stamped output in Collections/Signed, once the driver has closed it */
  signedFileId?: string | null;
  signedFilePath?: string | null;
  signedByName?: string | null;
  collectedAt?: Date | null;
  driverId?: string | null;
}

export interface TripStop {
  id: string;
  stopNumber: number;
  /** Empty on a collection-only stop — nothing is being delivered there. */
  invoiceNumber: string;
  customerName: string;
  address: string;
  nop: number;
  invoiceFile?: string | null;
  status: string;
  signedAt?: Date | null;
  emailSentAt?: Date | null;
  emailStatus?: string;
  emailError?: string | null;
  emailAttempts?: number;
  contact?: { email?: string | null };
  collections?: TripCollection[];
}

export interface TripSheet {
  id: string;
  driverId: string;
  driverName: string;
  regNo: string;
  status: "ACTIVE" | "QUEUED";
  uploadedAt: Date;
  uploadedBy: string;
  sourceFilename: string;
  stops: TripStop[];
}

/** One frozen stop inside a CompletedTripSheet.stops snapshot. */
export interface ArchivedStop {
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  address: string;
  nop: number;
  signedAt: string | null;
  emailStatus: string;
}

/**
 * One frozen collection inside a CompletedTripSheet.collections snapshot.
 *
 * Carries both file references on purpose. The Collection row cascades away
 * with the trip sheet, so this is the only record left of where the stamped PDF
 * and the original document went — and the archive view offers both. A
 * NOT_AVAILABLE collection has no signed file and still belongs here: "we went
 * and it was not there" is part of a complete record.
 */
export interface ArchivedCollection {
  collectionNo: string;
  type: string;
  upliftSubtype: string | null;
  originalInvoiceNo: string | null;
  status: string;
  exceptionReason: string | null;
  notes: string | null;
  expectedQty: number | null;
  collectedQty: number | null;
  customerName: string;
  stopNumber: number | null;
  signedByName: string | null;
  collectedAt: string | null;
  sourceFilePath: string | null;
  signedFileId: string | null;
  signedFilePath: string | null;
}

export interface CompletedTripSheet {
  id: string;
  tripSheetId: string;
  driverId: string;
  driverName: string;
  regNo: string;
  sourceFilename: string;
  archivedFile: string | null;
  uploadedAt: Date;
  uploadedBy: string;
  completedAt: Date;
  completedBy: string | null;
  totalStops: number;
  signedStops: number;
  totalCollections: number;
  collectedCollections: number;
  stops: ArchivedStop[];
  collections: ArchivedCollection[];
}

// ─── Trip Sheet Operations ────────────────────────────────────────────────

/**
 * Save a new trip sheet for a driver.
 * All trip sheets are immediately ACTIVE — drivers can have multiple active sheets.
 */
export async function saveTripSheet(
  tenantId: string,
  trip: {
    driverId: string;
    driverName: string;
    regNo: string;
    uploadedBy: string;
    sourceFilename: string;
    stops: (Omit<TripStop, "id"> & { collections?: Omit<TripCollection, "id">[] })[];
  }
): Promise<TripSheet> {
  const db = scopedPrisma(tenantId);
  const status: "ACTIVE" | "QUEUED" = "ACTIVE";

  // The scoped client stamps tenantId on the sheet AND on the nested stops.
  const created = await db.tripSheet.create({
    data: {
      sourceFilename: trip.sourceFilename,
      uploadedBy: trip.uploadedBy,
      driverId: trip.driverId,
      regNo: trip.regNo || null,
      status,
      stops: {
        create: trip.stops.map((stop) => ({
          stopNumber: stop.stopNumber,
          invoiceNumber: stop.invoiceNumber,
          customerName: stop.customerName,
          address: stop.address || "",
          nop: stop.nop || 0,
          invoiceFile: stop.invoiceFile,
          status: (stop.status || "PENDING") as PrismaStopStatus,
        })),
      },
    },
  });

  const stops = await db.stop.findMany({
    where: { tripSheetId: created.id },
    orderBy: { stopNumber: "asc" },
  });

  // Collections are written after the stops rather than nested inside them:
  // Collection carries composite foreign keys to BOTH the trip sheet and the
  // stop, and a nested create under Stop has no way to name the trip sheet that
  // is being created in the same statement. Stop numbers are unique within a
  // sheet (the deploy route renumbers them), so they are what the preview rows
  // are joined back to their persisted stops by.
  const stopIdByNumber = new Map(stops.map((s) => [s.stopNumber, s.id]));

  for (const stop of trip.stops) {
    if ((stop.collections?.length ?? 0) > 0 && !stopIdByNumber.has(stop.stopNumber)) {
      // Both deploy paths renumber stops 1..n before calling this, so a stop
      // number that does not come back is a caller bug. Saying so beats writing
      // a collection with no stop, or dropping it silently — a collection the
      // driver never sees is goods left at a customer with no record.
      throw new Error(
        `saveTripSheet: stop number ${stop.stopNumber} carries collections but did not persist — stop numbers must be unique within a sheet`
      );
    }
  }

  const collectionRows = trip.stops.flatMap((stop) =>
    (stop.collections ?? []).map((collection) => ({
      collectionNo: collection.collectionNo,
      type: collection.type,
      upliftSubtype: collection.upliftSubtype ?? null,
      notes: collection.notes ?? null,
      originalInvoiceNo: collection.originalInvoiceNo ?? null,
      exceptionReason: null,
      expectedQty: collection.expectedQty ?? null,
      sourceFileId: collection.sourceFileId ?? null,
      sourceFilePath: collection.sourceFilePath ?? null,
      tripSheetId: created.id,
      stopId: stopIdByNumber.get(stop.stopNumber)!,
    }))
  );

  let collections: Awaited<ReturnType<typeof db.collection.findMany>> = [];
  if (collectionRows.length > 0) {
    await db.collection.createMany({ data: collectionRows });
    collections = await db.collection.findMany({
      where: { tripSheetId: created.id },
      orderBy: { collectionNo: "asc" },
    });
  }

  const collectionsByStop = new Map<string, typeof collections>();
  for (const collection of collections) {
    const existing = collectionsByStop.get(collection.stopId) || [];
    existing.push(collection);
    collectionsByStop.set(collection.stopId, existing);
  }

  await logAudit({
    action: "UPLOAD",
    entity: "trip_sheet",
    entityId: created.id,
    userName: trip.uploadedBy,
    details: `Trip sheet deployed: ${trip.sourceFilename} for driver ${trip.driverName} (${trip.stops.length} stops${
      collectionRows.length ? `, ${collectionRows.length} collections` : ""
    })`,
    tenantId,
  });

  return {
    id: created.id,
    driverId: created.driverId,
    driverName: trip.driverName,
    regNo: trip.regNo,
    status,
    uploadedAt: created.date,
    uploadedBy: created.uploadedBy,
    sourceFilename: created.sourceFilename,
    stops: stops.map((s) =>
      mapStop({ ...s, collections: collectionsByStop.get(s.id) })
    ),
  };
}

/**
 * Get all trip sheets in a scope, with their stops.
 */
export async function getAllTripSheets(tenantId: string): Promise<TripSheet[]> {
  const db = scopedPrisma(tenantId);

  const trips = await db.tripSheet.findMany({
    orderBy: { date: "desc" },
  });

  if (trips.length === 0) return [];

  const driverIds = [...new Set(trips.map((t) => t.driverId))];
  const [drivers, allStops] = await Promise.all([
    db.driver.findMany({
      where: { id: { in: driverIds } },
      select: { id: true, name: true },
    }),
    db.stop.findMany({
      where: { tripSheetId: { in: trips.map((t) => t.id) } },
      orderBy: { stopNumber: "asc" },
      include: {
        contact: { select: { email: true } },
        // A stop's collections travel with it everywhere a stop is read. The
        // driver's run sheet, the dispatcher's trip view and the completion
        // guard all need them, and a stop whose collections were silently
        // absent would look finished when it is not.
        collections: { orderBy: { collectionNo: "asc" } },
      },
    }),
  ]);

  const driverMap = new Map(drivers.map((d) => [d.id, d]));
  const stopsByTrip = new Map<string, typeof allStops>();
  for (const stop of allStops) {
    const existing = stopsByTrip.get(stop.tripSheetId) || [];
    existing.push(stop);
    stopsByTrip.set(stop.tripSheetId, existing);
  }

  return trips.map((t) => {
    const driver = driverMap.get(t.driverId);
    return {
      id: t.id,
      driverId: t.driverId,
      driverName: driver?.name || "Unknown",
      regNo: t.regNo || "",
      status: t.status as "ACTIVE" | "QUEUED",
      uploadedAt: t.date,
      uploadedBy: t.uploadedBy,
      sourceFilename: t.sourceFilename,
      stops: (stopsByTrip.get(t.id) || []).map(mapStop),
    };
  });
}

/**
 * Get one trip sheet by id, or null if it isn't in this scope.
 */
export async function getTripSheet(
  tenantId: string,
  tripId: string
): Promise<TripSheet | null> {
  const db = scopedPrisma(tenantId);

  const trip = await db.tripSheet.findFirst({ where: { id: tripId } });
  if (!trip) return null;

  const [driver, stops] = await Promise.all([
    db.driver.findFirst({
      where: { id: trip.driverId },
      select: { name: true },
    }),
    db.stop.findMany({
      where: { tripSheetId: trip.id },
      orderBy: { stopNumber: "asc" },
      include: {
        contact: { select: { email: true } },
        // A stop's collections travel with it everywhere a stop is read. The
        // driver's run sheet, the dispatcher's trip view and the completion
        // guard all need them, and a stop whose collections were silently
        // absent would look finished when it is not.
        collections: { orderBy: { collectionNo: "asc" } },
      },
    }),
  ]);

  return {
    id: trip.id,
    driverId: trip.driverId,
    driverName: driver?.name || "Unknown",
    regNo: trip.regNo || "",
    status: trip.status as "ACTIVE" | "QUEUED",
    uploadedAt: trip.date,
    uploadedBy: trip.uploadedBy,
    sourceFilename: trip.sourceFilename,
    stops: stops.map(mapStop),
  };
}

/**
 * Get all trip sheets for a specific driver (active first, then queued by date).
 */
export async function getTripSheetsForDriver(
  tenantId: string,
  driverId: string
): Promise<TripSheet[]> {
  const db = scopedPrisma(tenantId);

  const trips = await db.tripSheet.findMany({
    where: { driverId },
    orderBy: [{ status: "asc" }, { date: "asc" }],
  });

  if (trips.length === 0) return [];

  const [driver, allStops] = await Promise.all([
    db.driver.findFirst({
      where: { id: driverId },
      select: { name: true },
    }),
    db.stop.findMany({
      where: { tripSheetId: { in: trips.map((t) => t.id) } },
      orderBy: { stopNumber: "asc" },
      include: {
        contact: { select: { email: true } },
        // A stop's collections travel with it everywhere a stop is read. The
        // driver's run sheet, the dispatcher's trip view and the completion
        // guard all need them, and a stop whose collections were silently
        // absent would look finished when it is not.
        collections: { orderBy: { collectionNo: "asc" } },
      },
    }),
  ]);

  const stopsByTrip = new Map<string, typeof allStops>();
  for (const stop of allStops) {
    const existing = stopsByTrip.get(stop.tripSheetId) || [];
    existing.push(stop);
    stopsByTrip.set(stop.tripSheetId, existing);
  }

  return trips.map((t) => ({
    id: t.id,
    driverId: t.driverId,
    driverName: driver?.name || "Unknown",
    regNo: t.regNo || "",
    status: t.status as "ACTIVE" | "QUEUED",
    uploadedAt: t.date,
    uploadedBy: t.uploadedBy,
    sourceFilename: t.sourceFilename,
    stops: (stopsByTrip.get(t.id) || []).map(mapStop),
  }));
}

/**
 * Get the active trip sheet for a specific driver (backwards compat).
 */
export async function getTripSheetForDriver(
  tenantId: string,
  driverId: string
): Promise<TripSheet | null> {
  const sheets = await getTripSheetsForDriver(tenantId, driverId);
  return sheets.find((s) => s.status === "ACTIVE") || sheets[0] || null;
}

/**
 * Get all stops from the active trip sheet for a specific driver.
 */
export async function getStopsForDriver(
  tenantId: string,
  driverId: string
): Promise<TripStop[]> {
  const trip = await getTripSheetForDriver(tenantId, driverId);
  return trip?.stops || [];
}

/**
 * Update a stop's status. A stop id from another scope is "not found".
 */
export async function updateStopStatus(
  tenantId: string,
  stopId: string,
  status: StopStatus,
  signatureData?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = scopedPrisma(tenantId);

    const stop = await db.stop.findFirst({ where: { id: stopId } });

    if (!stop) {
      return { success: false, error: "Stop not found" };
    }

    await db.stop.update({
      where: { id: stopId },
      data: {
        status: status as PrismaStopStatus,
        ...(status === "SIGNED" && { signedAt: new Date() }),
        ...(signatureData && { signatureData }),
      },
    });

    // Get driver info for audit log
    const tripSheet = await db.tripSheet.findFirst({
      where: { id: stop.tripSheetId },
    });
    const driver = tripSheet
      ? await db.driver.findFirst({ where: { id: tripSheet.driverId } })
      : null;

    await logAudit({
      action: status === "SIGNED" ? "SIGN" : "STATUS_CHANGE",
      entity: "stop",
      entityId: stopId,
      userName: driver?.name || "Unknown",
      details: `Stop ${stop.stopNumber} (${stop.invoiceNumber}) → ${status}`,
      tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to update stop status:", err);
    return { success: false, error: "Failed to update stop" };
  }
}

/**
 * Delete a trip sheet by ID.
 */
export async function deleteTripSheet(
  tenantId: string,
  tripId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = scopedPrisma(tenantId);

    const trip = await db.tripSheet.findFirst({ where: { id: tripId } });

    if (!trip) {
      return { success: false, error: "Trip sheet not found" };
    }

    const driver = await db.driver.findFirst({ where: { id: trip.driverId } });

    await db.tripSheet.delete({ where: { id: tripId } });

    await logAudit({
      action: "STATUS_CHANGE",
      entity: "trip_sheet",
      entityId: tripId,
      userName: trip.uploadedBy,
      details: `Trip sheet deleted for driver ${driver?.name || "Unknown"}`,
      tenantId,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to delete trip sheet:", err);
    return { success: false, error: "Failed to delete trip sheet" };
  }
}

/**
 * Complete a trip sheet: verify all stops are SIGNED, move the source file
 * to the processed/ subfolder, snapshot it into the archive, and delete the
 * trip sheet from the DB.
 * Returns { success, error?, archivedFile? }.
 */
export async function completeTripSheet(
  tenantId: string,
  tripId: string,
  completedBy?: string
): Promise<{ success: boolean; error?: string; archivedFile?: string | null }> {
  try {
    const db = scopedPrisma(tenantId);

    const trip = await db.tripSheet.findFirst({ where: { id: tripId } });

    if (!trip) {
      return { success: false, error: "Trip sheet not found" };
    }

    // Verify all stops are SIGNED
    const stops = await db.stop.findMany({
      where: { tripSheetId: tripId },
      orderBy: { stopNumber: "asc" },
    });

    const allSigned = stops.length > 0 && stops.every((s) => s.status === "SIGNED");
    if (!allSigned) {
      return {
        success: false,
        error: `Cannot complete: ${stops.filter((s) => s.status !== "SIGNED").length} stop(s) are not yet signed`,
      };
    }

    // A stop is not finished until everything at that address is finished —
    // every invoice signed AND every collection given a final outcome. Closing
    // out a trip with a collection still PENDING would delete the row and leave
    // goods the customer believes were taken with no record at all, because the
    // archive below can only freeze what it can see.
    const collections = await db.collection.findMany({
      where: { tripSheetId: tripId },
      orderBy: { collectionNo: "asc" },
    });

    const outstanding = collections.filter((c) => !isTerminalStatus(c.status));
    if (outstanding.length > 0) {
      return {
        success: false,
        error: `Cannot complete: ${outstanding.length} collection(s) have no outcome yet (${outstanding
          .slice(0, 3)
          .map((c) => c.collectionNo)
          .join(", ")}${outstanding.length > 3 ? "…" : ""})`,
      };
    }

    const stopById = new Map(stops.map((s) => [s.id, s]));

    const driver = await db.driver.findFirst({ where: { id: trip.driverId } });

    // Move source file to processed/ subfolder — in this scope's own folder or
    // OneDrive connection, never another admin's. This is what backups read as
    // the set of "completed" trip sheets, so a failure here must be visible.
    let archivedFile: string | null = null;
    if (trip.sourceFilename) {
      archivedFile = await moveToProcessed(tenantId, trip.sourceFilename);
      if (!archivedFile) {
        console.warn(
          `completeTripSheet: source file "${trip.sourceFilename}" was not archived to processed/ (not found or move failed) — it will not appear in backups`
        );
      }
    }

    // Snapshot BEFORE the delete. Deleting the sheet is what keeps finished
    // stops out of every driver's run sheet and out of the change-feed cursor,
    // but it used to take the day's record with it — a dispatcher who closed
    // out a route could no longer see it had happened.
    //
    // Frozen as JSON on purpose: this is an archive of what was delivered, and
    // later edits to a driver or a contact must not be able to rewrite it.
    await db.completedTripSheet.create({
      data: {
        tripSheetId: trip.id,
        driverId: trip.driverId,
        driverName: driver?.name || "Unknown",
        regNo: trip.regNo,
        sourceFilename: trip.sourceFilename,
        archivedFile,
        uploadedAt: trip.date,
        uploadedBy: trip.uploadedBy,
        completedBy: completedBy ?? null,
        totalStops: stops.length,
        signedStops: stops.filter((s) => s.status === "SIGNED").length,
        totalCollections: collections.length,
        collectedCollections: collections.filter(
          (c) => c.status === "COLLECTED" || c.status === "PARTIAL"
        ).length,
        stops: stops.map((s) => ({
          stopNumber: s.stopNumber,
          invoiceNumber: s.invoiceNumber,
          customerName: s.customerName,
          address: s.address,
          nop: s.nop,
          signedAt: s.signedAt ? s.signedAt.toISOString() : null,
          emailStatus: s.emailStatus,
        })),
        // Frozen for the same reason the stops are, and carrying both file
        // references: the Collection rows cascade away with the trip sheet
        // below, so this is the whole record the archive view and the
        // credit-return report read afterwards. The PDFs themselves stay in
        // Collections/Signed permanently — nothing is moved or deleted when a
        // trip closes.
        collections: collections.map((c) => {
          const stop = stopById.get(c.stopId);
          return {
            collectionNo: c.collectionNo,
            type: c.type,
            upliftSubtype: c.upliftSubtype,
            originalInvoiceNo: c.originalInvoiceNo,
            status: c.status,
            exceptionReason: c.exceptionReason,
            notes: c.notes,
            expectedQty: c.expectedQty,
            collectedQty: c.collectedQty,
            customerName: stop?.customerName ?? "Unknown",
            stopNumber: stop?.stopNumber ?? null,
            signedByName: c.signedByName,
            collectedAt: c.collectedAt ? c.collectedAt.toISOString() : null,
            sourceFilePath: c.sourceFilePath,
            signedFileId: c.signedFileId,
            signedFilePath: c.signedFilePath,
          };
        }),
      },
    });

    // Delete the trip sheet (cascades to stops)
    await db.tripSheet.delete({ where: { id: tripId } });

    await logAudit({
      action: "STATUS_CHANGE",
      entity: "trip_sheet",
      entityId: tripId,
      userName: trip.uploadedBy,
      details: `Trip sheet completed for driver ${driver?.name || "Unknown"} (${stops.length} stops, all signed${
        collections.length ? `; ${collections.length} collections closed out` : ""
      })${
        trip.sourceFilename
          ? archivedFile
            ? ` — archived ${trip.sourceFilename} to processed/`
            : ` — WARNING: ${trip.sourceFilename} could not be archived to processed/`
          : ""
      }`,
      tenantId,
    });

    return { success: true, archivedFile };
  } catch (err) {
    console.error("Failed to complete trip sheet:", err);
    return { success: false, error: "Failed to complete trip sheet" };
  }
}

/**
 * Batch complete multiple trip sheets.
 *
 * Each sheet costs several database round trips plus a OneDrive file move, so
 * these run with bounded parallelism — sequentially, an end-of-day close-out of
 * twenty sheets could outlast the serverless function's time limit.
 *
 * Partial success is deliberate: one sheet failing (a stop still unsigned, a
 * source file already moved) must not abandon the rest, so the worker resolves
 * to a result rather than throwing.
 */
export async function completeTripSheets(
  tenantId: string,
  tripIds: string[],
  completedBy?: string
): Promise<{ completed: number; failed: { id: string; error: string }[] }> {
  const results = await mapWithConcurrency(tripIds, async (id) => ({
    id,
    outcome: await completeTripSheet(tenantId, id, completedBy),
  }));

  let completed = 0;
  const failed: { id: string; error: string }[] = [];

  for (const { id, outcome } of results) {
    if (outcome.success) {
      completed++;
    } else {
      failed.push({ id, error: outcome.error || "Unknown error" });
    }
  }

  return { completed, failed };
}

/**
 * Batch delete multiple trip sheets by IDs.
 * Bounded parallelism, partial success — see completeTripSheets above.
 */
export async function deleteTripSheets(
  tenantId: string,
  tripIds: string[]
): Promise<{ deleted: number; failed: string[] }> {
  const results = await mapWithConcurrency(tripIds, async (id) => ({
    id,
    outcome: await deleteTripSheet(tenantId, id),
  }));

  let deleted = 0;
  const failed: string[] = [];

  for (const { id, outcome } of results) {
    if (outcome.success) {
      deleted++;
    } else {
      failed.push(id);
    }
  }

  return { deleted, failed };
}

/**
 * Read the completed-trip-sheet archive for one scope, newest first.
 *
 * @param opts.since  Inclusive lower bound on completedAt. The trip sheet page
 *                    passes the start of the dispatcher's local day.
 * @param opts.until  Exclusive upper bound on completedAt.
 * @param opts.limit  Hard cap; the archive grows without bound, so every caller
 *                    gets one whether it asks or not.
 */
export async function getCompletedTripSheets(
  tenantId: string,
  opts: { since?: Date; until?: Date; limit?: number } = {}
): Promise<CompletedTripSheet[]> {
  const db = scopedPrisma(tenantId);
  const { since, until, limit = 100 } = opts;

  const rows = await db.completedTripSheet.findMany({
    where:
      since || until
        ? { completedAt: { ...(since && { gte: since }), ...(until && { lt: until }) } }
        : {},
    orderBy: { completedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
  });

  return rows.map((r) => ({
    id: r.id,
    tripSheetId: r.tripSheetId,
    driverId: r.driverId,
    driverName: r.driverName,
    regNo: r.regNo || "",
    sourceFilename: r.sourceFilename,
    archivedFile: r.archivedFile,
    uploadedAt: r.uploadedAt,
    uploadedBy: r.uploadedBy,
    completedAt: r.completedAt,
    completedBy: r.completedBy,
    totalStops: r.totalStops,
    signedStops: r.signedStops,
    totalCollections: r.totalCollections,
    collectedCollections: r.collectedCollections,
    // Written by completeTripSheet above and never updated, so the shape is
    // ours — but it is still JSON coming back out of the database.
    stops: Array.isArray(r.stops) ? (r.stops as unknown as ArchivedStop[]) : [],
    // Null on every trip archived before collections existed, which reads
    // correctly as "this trip had none".
    collections: Array.isArray(r.collections)
      ? (r.collections as unknown as ArchivedCollection[])
      : [],
  }));
}

/**
 * Get summary stats across one scope's trip sheets.
 */
export async function getTripStats(tenantId: string): Promise<{
  totalStops: number;
  signed: number;
  pending: number;
  inProgress: number;
  activeDrivers: number;
}> {
  const db = scopedPrisma(tenantId);

  const [totalStops, signed, pending, inProgress, activeDrivers] =
    await Promise.all([
      db.stop.count(),
      db.stop.count({ where: { status: "SIGNED" } }),
      db.stop.count({ where: { status: "PENDING" } }),
      db.stop.count({ where: { status: "IN_PROGRESS" } }),
      db.tripSheet.findMany({
        select: { driverId: true },
        distinct: ["driverId"],
      }),
    ]);

  return {
    totalStops,
    signed,
    pending,
    inProgress,
    activeDrivers: activeDrivers.length,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function mapStop(stop: {
  id: string;
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  address: string;
  nop: number;
  invoiceFile: string | null;
  status: string;
  signedAt: Date | null;
  emailSentAt?: Date | null;
  emailStatus?: string;
  emailError?: string | null;
  emailAttempts?: number;
  contact?: { email: string | null } | null;
  collections?: RawCollection[] | null;
}): TripStop {
  return {
    id: stop.id,
    stopNumber: stop.stopNumber,
    invoiceNumber: stop.invoiceNumber,
    customerName: stop.customerName,
    address: stop.address,
    nop: stop.nop,
    invoiceFile: stop.invoiceFile,
    status: stop.status,
    signedAt: stop.signedAt,
    emailSentAt: stop.emailSentAt,
    emailStatus: stop.emailStatus,
    emailError: stop.emailError,
    emailAttempts: stop.emailAttempts,
    contact: stop.contact ? { email: stop.contact.email } : undefined,
    collections: stop.collections ? stop.collections.map(mapCollection) : undefined,
  };
}

/** The Collection columns mapStop is handed, whichever query loaded them. */
interface RawCollection {
  id: string;
  collectionNo: string;
  type: CollectionType;
  upliftSubtype: UpliftSubtype | null;
  notes: string | null;
  originalInvoiceNo: string | null;
  status: CollectionStatus;
  exceptionReason: string | null;
  expectedQty: number | null;
  collectedQty: number | null;
  sourceFileId: string | null;
  sourceFilePath: string | null;
  signedFileId: string | null;
  signedFilePath: string | null;
  signedByName: string | null;
  collectedAt: Date | null;
  driverId: string | null;
}

/**
 * Note what is deliberately NOT mapped: `signature`. It is a full-size PNG data
 * URL and every stop list would otherwise carry one per collection, over a
 * mobile connection, for a payload nothing on those screens renders.
 */
function mapCollection(collection: RawCollection): TripCollection {
  return {
    id: collection.id,
    collectionNo: collection.collectionNo,
    type: collection.type,
    upliftSubtype: collection.upliftSubtype,
    notes: collection.notes,
    originalInvoiceNo: collection.originalInvoiceNo,
    status: collection.status,
    exceptionReason: collection.exceptionReason,
    expectedQty: collection.expectedQty,
    collectedQty: collection.collectedQty,
    sourceFileId: collection.sourceFileId,
    sourceFilePath: collection.sourceFilePath,
    signedFileId: collection.signedFileId,
    signedFilePath: collection.signedFilePath,
    signedByName: collection.signedByName,
    collectedAt: collection.collectedAt,
    driverId: collection.driverId,
  };
}

// ─── Collections reporting ────────────────────────────────────────────────
//
// Accounts reconciles credit returns from two places, because a collection has
// two lives. While its trip is open it is a Collection row; once the trip is
// closed out the row cascades away and it survives as a frozen entry in that
// trip's CompletedTripSheet.collections snapshot.
//
// Merging them here rather than at each call site is what keeps "credit returns
// in September" from silently meaning "credit returns in September on trips
// nobody has closed yet" — which, at the end of a month, is almost none of them.

/** One collection as the dispatcher and accounts see it, live or archived. */
export interface CollectionRecord {
  /** Null once the trip is closed — the row is gone and this is a snapshot. */
  id: string | null;
  collectionNo: string;
  type: string;
  upliftSubtype: string | null;
  originalInvoiceNo: string | null;
  status: string;
  exceptionReason: string | null;
  notes: string | null;
  expectedQty: number | null;
  collectedQty: number | null;
  customerName: string;
  stopNumber: number | null;
  signedByName: string | null;
  collectedAt: Date | null;
  sourceFilePath: string | null;
  signedFileId: string | null;
  signedFilePath: string | null;
  driverId: string | null;
  driverName: string | null;
  /** The live trip sheet, or the archived trip's original id. */
  tripSheetId: string;
  /** True when this came out of a CompletedTripSheet snapshot. */
  archived: boolean;
  /** The archive row it came from, for linking back to the completed trip. */
  completedTripSheetId: string | null;
}

export interface CollectionQuery {
  type?: CollectionType;
  status?: CollectionStatus;
  /** Inclusive lower bound on collectedAt (archived rows included by trip). */
  since?: Date;
  /** Exclusive upper bound. */
  until?: Date;
  driverId?: string;
  tripSheetId?: string;
  /** Default true. Set false for "what is still outstanding today". */
  includeArchived?: boolean;
  /** Default false — only collections that reached an outcome. */
  onlyCompleted?: boolean;
  limit?: number;
}

/**
 * Read collections across the live trips and the archive.
 *
 * The date bound is applied to `collectedAt` on both sides — the moment the
 * driver closed it out, not the moment the trip was archived, because a trip
 * closed on Monday can contain a collection made on Friday. A collection with
 * no outcome yet has no collectedAt and so falls outside any date range by
 * construction, which is the right answer for a credit report and the wrong one
 * for an outstanding-work list; that is what `onlyCompleted` distinguishes.
 */
export async function listCollections(
  tenantId: string,
  query: CollectionQuery = {}
): Promise<CollectionRecord[]> {
  const db = scopedPrisma(tenantId);
  const {
    type,
    status,
    since,
    until,
    driverId,
    tripSheetId,
    includeArchived = true,
    onlyCompleted = false,
    limit = 500,
  } = query;

  const cap = Math.min(Math.max(limit, 1), 2000);

  const inRange = (at: Date | null): boolean => {
    if (!since && !until) return true;
    if (!at) return false;
    if (since && at < since) return false;
    if (until && at >= until) return false;
    return true;
  };

  const live = await db.collection.findMany({
    where: {
      ...(type && { type }),
      ...(status && { status }),
      ...(tripSheetId && { tripSheetId }),
      ...(driverId && { tripSheet: { driverId } }),
      ...(onlyCompleted && { collectedAt: { not: null } }),
      ...((since || until) && {
        collectedAt: {
          ...(since && { gte: since }),
          ...(until && { lt: until }),
        },
      }),
    },
    include: {
      stop: { select: { customerName: true, stopNumber: true } },
      tripSheet: { select: { driverId: true, driver: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: cap,
  });

  const records: CollectionRecord[] = live.map((c) => ({
    id: c.id,
    collectionNo: c.collectionNo,
    type: c.type,
    upliftSubtype: c.upliftSubtype,
    originalInvoiceNo: c.originalInvoiceNo,
    status: c.status,
    exceptionReason: c.exceptionReason,
    notes: c.notes,
    expectedQty: c.expectedQty,
    collectedQty: c.collectedQty,
    customerName: c.stop.customerName,
    stopNumber: c.stop.stopNumber,
    signedByName: c.signedByName,
    collectedAt: c.collectedAt,
    sourceFilePath: c.sourceFilePath,
    signedFileId: c.signedFileId,
    signedFilePath: c.signedFilePath,
    driverId: c.tripSheet.driverId,
    driverName: c.tripSheet.driver?.name ?? null,
    tripSheetId: c.tripSheetId,
    archived: false,
    completedTripSheetId: null,
  }));

  if (!includeArchived) return records.slice(0, cap);

  // The archive is filtered in JS because the collections are JSON. Bounded
  // rather than open-ended: the candidate archive rows are narrowed by driver
  // and by a generous completedAt window first, so this never walks a scope's
  // whole history. A collection is closed out on the trip that carried it, so
  // an archive row completed before the window opened cannot hold one inside it.
  const archives = await db.completedTripSheet.findMany({
    where: {
      totalCollections: { gt: 0 },
      ...(driverId && { driverId }),
      ...(tripSheetId && { tripSheetId }),
      ...(since && { completedAt: { gte: since } }),
    },
    orderBy: { completedAt: "desc" },
    take: 500,
  });

  for (const archive of archives) {
    const frozen = Array.isArray(archive.collections)
      ? (archive.collections as unknown as ArchivedCollection[])
      : [];

    for (const c of frozen) {
      if (type && c.type !== type) continue;
      if (status && c.status !== status) continue;

      const collectedAt = c.collectedAt ? new Date(c.collectedAt) : null;
      if (onlyCompleted && !collectedAt) continue;
      if (!inRange(collectedAt)) continue;

      records.push({
        id: null,
        collectionNo: c.collectionNo,
        type: c.type,
        upliftSubtype: c.upliftSubtype,
        originalInvoiceNo: c.originalInvoiceNo,
        status: c.status,
        exceptionReason: c.exceptionReason,
        notes: c.notes,
        expectedQty: c.expectedQty,
        collectedQty: c.collectedQty,
        customerName: c.customerName,
        stopNumber: c.stopNumber,
        signedByName: c.signedByName,
        collectedAt,
        sourceFilePath: c.sourceFilePath,
        signedFileId: c.signedFileId,
        signedFilePath: c.signedFilePath,
        driverId: archive.driverId,
        driverName: archive.driverName,
        tripSheetId: archive.tripSheetId,
        archived: true,
        completedTripSheetId: archive.id,
      });
    }
  }

  // Newest outcome first; anything still outstanding sorts to the top, because
  // that is what a dispatcher is looking for in a mixed list.
  records.sort((a, b) => {
    if (!a.collectedAt && !b.collectedAt) return 0;
    if (!a.collectedAt) return -1;
    if (!b.collectedAt) return 1;
    return b.collectedAt.getTime() - a.collectedAt.getTime();
  });

  return records.slice(0, cap);
}
