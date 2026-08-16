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
import { moveToProcessed } from "./trip-sheet-folder";
import { mapWithConcurrency } from "./concurrency";

export type StopStatus = "PENDING" | "IN_PROGRESS" | "SIGNED";

export interface TripStop {
  id: string;
  stopNumber: number;
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
  stops: ArchivedStop[];
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
    stops: Omit<TripStop, "id">[];
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

  await logAudit({
    action: "UPLOAD",
    entity: "trip_sheet",
    entityId: created.id,
    userName: trip.uploadedBy,
    details: `Trip sheet deployed: ${trip.sourceFilename} for driver ${trip.driverName} (${trip.stops.length} stops)`,
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
    stops: stops.map(mapStop),
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
      include: { contact: { select: { email: true } } },
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
      include: { contact: { select: { email: true } } },
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
      include: { contact: { select: { email: true } } },
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
        stops: stops.map((s) => ({
          stopNumber: s.stopNumber,
          invoiceNumber: s.invoiceNumber,
          customerName: s.customerName,
          address: s.address,
          nop: s.nop,
          signedAt: s.signedAt ? s.signedAt.toISOString() : null,
          emailStatus: s.emailStatus,
        })),
      },
    });

    // Delete the trip sheet (cascades to stops)
    await db.tripSheet.delete({ where: { id: tripId } });

    await logAudit({
      action: "STATUS_CHANGE",
      entity: "trip_sheet",
      entityId: tripId,
      userName: trip.uploadedBy,
      details: `Trip sheet completed for driver ${driver?.name || "Unknown"} (${stops.length} stops, all signed)${
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
    // Written by completeTripSheet above and never updated, so the shape is
    // ours — but it is still JSON coming back out of the database.
    stops: Array.isArray(r.stops) ? (r.stops as unknown as ArchivedStop[]) : [],
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
  };
}
