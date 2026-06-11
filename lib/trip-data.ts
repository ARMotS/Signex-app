/**
 * Trip sheet data — PostgreSQL via Prisma.
 * Each trip sheet is assigned to a specific driver and contains stops.
 * Operations include eager loading of related stops.
 */

import { prisma } from "./db";
import { logAudit } from "./audit";
import { StopStatus as PrismaStopStatus } from "@prisma/client";
import { moveToProcessed } from "./trip-sheet-folder";

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

// ─── Trip Sheet Operations ────────────────────────────────────────────────

/**
 * Save a new trip sheet for a driver.
 * All trip sheets are immediately ACTIVE — drivers can have multiple active sheets.
 */
export async function saveTripSheet(trip: {
  driverId: string;
  driverName: string;
  regNo: string;
  uploadedBy: string;
  sourceFilename: string;
  stops: Omit<TripStop, "id">[];
  tenantId: string;
}): Promise<TripSheet> {
  const status: "ACTIVE" | "QUEUED" = "ACTIVE";

  const created = await prisma.tripSheet.create({
    data: {
      sourceFilename: trip.sourceFilename,
      uploadedBy: trip.uploadedBy,
      driverId: trip.driverId,
      regNo: trip.regNo || null,
      status,
      tenantId: trip.tenantId,
      stops: {
        create: trip.stops.map((stop) => ({
          stopNumber: stop.stopNumber,
          invoiceNumber: stop.invoiceNumber,
          customerName: stop.customerName,
          address: stop.address || "",
          nop: stop.nop || 0,
          invoiceFile: stop.invoiceFile,
          status: (stop.status || "PENDING") as PrismaStopStatus,
          tenantId: trip.tenantId,
        })),
      },
    },
  });

  const stops = await prisma.stop.findMany({
    where: { tripSheetId: created.id },
    orderBy: { stopNumber: "asc" },
  });

  await logAudit({
    action: "UPLOAD",
    entity: "trip_sheet",
    entityId: created.id,
    userName: trip.uploadedBy,
    details: `Trip sheet deployed: ${trip.sourceFilename} for driver ${trip.driverName} (${trip.stops.length} stops)`,
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
 * Get all trip sheets with their stops.
 */
export async function getAllTripSheets(tenantId?: string): Promise<TripSheet[]> {
  const trips = await prisma.tripSheet.findMany({
    where: tenantId ? { tenantId } : undefined,
    orderBy: { date: "desc" },
  });

  // Get all driver info and stops in parallel
  const driverIds = [...new Set(trips.map((t) => t.driverId))];
  const [drivers, allStops] = await Promise.all([
    prisma.driver.findMany({
      where: { id: { in: driverIds } },
      select: { id: true, name: true },
    }),
    prisma.stop.findMany({
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
 * Get all trip sheets for a specific driver (active first, then queued by date).
 */
export async function getTripSheetsForDriver(
  driverId: string
): Promise<TripSheet[]> {
  const trips = await prisma.tripSheet.findMany({
    where: { driverId },
    orderBy: [{ status: "asc" }, { date: "asc" }],
  });

  if (trips.length === 0) return [];

  const [driver, allStops] = await Promise.all([
    prisma.driver.findUnique({
      where: { id: driverId },
      select: { name: true },
    }),
    prisma.stop.findMany({
      where: { tripSheetId: { in: trips.map((t) => t.id) } },
      orderBy: { stopNumber: "asc" },
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
  driverId: string
): Promise<TripSheet | null> {
  const sheets = await getTripSheetsForDriver(driverId);
  return sheets.find((s) => s.status === "ACTIVE") || sheets[0] || null;
}

/**
 * Get all stops from the active trip sheet for a specific driver.
 */
export async function getStopsForDriver(driverId: string): Promise<TripStop[]> {
  const trip = await getTripSheetForDriver(driverId);
  return trip?.stops || [];
}

/**
 * Update a stop's status.
 */
export async function updateStopStatus(
  stopId: string,
  status: StopStatus,
  signatureData?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const stop = await prisma.stop.findUnique({
      where: { id: stopId },
    });

    if (!stop) {
      return { success: false, error: "Stop not found" };
    }

    await prisma.stop.update({
      where: { id: stopId },
      data: {
        status: status as PrismaStopStatus,
        ...(status === "SIGNED" && { signedAt: new Date() }),
        ...(signatureData && { signatureData }),
      },
    });

    // Get driver info for audit log
    const tripSheet = await prisma.tripSheet.findUnique({
      where: { id: stop.tripSheetId },
    });
    const driver = tripSheet
      ? await prisma.driver.findUnique({ where: { id: tripSheet.driverId } })
      : null;

    await logAudit({
      action: status === "SIGNED" ? "SIGN" : "STATUS_CHANGE",
      entity: "stop",
      entityId: stopId,
      userName: driver?.name || "Unknown",
      details: `Stop ${stop.stopNumber} (${stop.invoiceNumber}) → ${status}`,
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
  tripId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const trip = await prisma.tripSheet.findUnique({
      where: { id: tripId },
    });

    if (!trip) {
      return { success: false, error: "Trip sheet not found" };
    }

    const driver = await prisma.driver.findUnique({
      where: { id: trip.driverId },
    });

    await prisma.tripSheet.delete({ where: { id: tripId } });

    await logAudit({
      action: "STATUS_CHANGE",
      entity: "trip_sheet",
      entityId: tripId,
      userName: trip.uploadedBy,
      details: `Trip sheet deleted for driver ${driver?.name || "Unknown"}`,
    });

    return { success: true };
  } catch (err) {
    console.error("Failed to delete trip sheet:", err);
    return { success: false, error: "Failed to delete trip sheet" };
  }
}

/**
 * Complete a trip sheet: verify all stops are SIGNED, move the source file
 * to the processed/ subfolder, and delete the trip sheet from the DB.
 * Returns { success, error?, archivedFile? }.
 */
export async function completeTripSheet(
  tripId: string
): Promise<{ success: boolean; error?: string; archivedFile?: string | null }> {
  try {
    const trip = await prisma.tripSheet.findUnique({
      where: { id: tripId },
    });

    if (!trip) {
      return { success: false, error: "Trip sheet not found" };
    }

    // Verify all stops are SIGNED
    const stops = await prisma.stop.findMany({
      where: { tripSheetId: tripId },
    });

    const allSigned = stops.length > 0 && stops.every((s) => s.status === "SIGNED");
    if (!allSigned) {
      return {
        success: false,
        error: `Cannot complete: ${stops.filter((s) => s.status !== "SIGNED").length} stop(s) are not yet signed`,
      };
    }

    const driver = await prisma.driver.findUnique({
      where: { id: trip.driverId },
    });

    // Move source file to processed/ subfolder
    let archivedFile: string | null = null;
    if (trip.sourceFilename) {
      archivedFile = await moveToProcessed(trip.sourceFilename);
    }

    // Delete the trip sheet (cascades to stops)
    await prisma.tripSheet.delete({ where: { id: tripId } });

    await logAudit({
      action: "STATUS_CHANGE",
      entity: "trip_sheet",
      entityId: tripId,
      userName: trip.uploadedBy,
      details: `Trip sheet completed and archived for driver ${driver?.name || "Unknown"} (${stops.length} stops, all signed)`,
    });

    return { success: true, archivedFile };
  } catch (err) {
    console.error("Failed to complete trip sheet:", err);
    return { success: false, error: "Failed to complete trip sheet" };
  }
}

/**
 * Batch complete multiple trip sheets.
 */
export async function completeTripSheets(
  tripIds: string[]
): Promise<{ completed: number; failed: { id: string; error: string }[] }> {
  let completed = 0;
  const failed: { id: string; error: string }[] = [];

  for (const id of tripIds) {
    const result = await completeTripSheet(id);
    if (result.success) {
      completed++;
    } else {
      failed.push({ id, error: result.error || "Unknown error" });
    }
  }

  return { completed, failed };
}

/**
 * Batch delete multiple trip sheets by IDs.
 */
export async function deleteTripSheets(
  tripIds: string[]
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];

  for (const id of tripIds) {
    const result = await deleteTripSheet(id);
    if (result.success) {
      deleted++;
    } else {
      failed.push(id);
    }
  }

  return { deleted, failed };
}

/**
 * Get summary stats across all trip sheets.
 */
export async function getTripStats(tenantId?: string): Promise<{
  totalStops: number;
  signed: number;
  pending: number;
  inProgress: number;
  activeDrivers: number;
}> {
  const tenantFilter = tenantId ? { tenantId } : {};
  const [totalStops, signed, pending, inProgress, activeDrivers] =
    await Promise.all([
      prisma.stop.count({ where: tenantFilter }),
      prisma.stop.count({ where: { ...tenantFilter, status: "SIGNED" } }),
      prisma.stop.count({ where: { ...tenantFilter, status: "PENDING" } }),
      prisma.stop.count({ where: { ...tenantFilter, status: "IN_PROGRESS" } }),
      prisma.tripSheet.findMany({
        where: tenantFilter,
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
    contact: stop.contact ? { email: stop.contact.email } : undefined,
  };
}
