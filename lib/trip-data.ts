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
import { Prisma, StopStatus as PrismaStopStatus } from "@prisma/client";
import type {
  CollectionStatus,
  CollectionType,
  UpliftSubtype,
} from "@prisma/client";
import { isTerminalStatus, removeSettledOriginals } from "./collections";
import { moveToProcessed } from "./trip-sheet-folder";
import { mapWithConcurrency } from "./concurrency";
import { readInvoiceNoPattern } from "./config";
import { normalizeInvoiceNo, normalizedInvoiceNoOrNull, type InvoiceNoPattern } from "./invoice-number";
import { ensureInvoices, scheduleInvoiceHeaders } from "./invoice-registry";
import { scheduleCollectionSheets } from "./collection-sheet-sync";

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
  /**
   * The invoice folder's PDF for originalInvoiceNo, if the preview found one.
   * Parse-time only — not a Collection column. Tells the deploy that the
   * invoice is on file, so it is not registered as a stub.
   */
  originalInvoiceFile?: string | null;
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
  /** Whether the office's sheet has been read into lines (lib/collection-sheet.ts). */
  sheetStatus?: "MISSING" | "READY" | "NEEDS_REVIEW";
  sheetIssues?: { code: string; level: "review" | "warning"; message: string }[] | null;
  /** What the office's sheet lists — the driver brings these back. Never priced. */
  lines?: TripCollectionLine[];
  /** The driver recorded "Not as listed". */
  hasVariance?: boolean;
  failReason?: string | null;
  /** Why the last attempt to read the office's sheet failed, if it did. */
  sheetError?: string | null;
}

export interface TripCollectionLine {
  lineNo: number;
  itemCode: string | null;
  shortName: string | null;
  description: string;
  qtyListed: number;
  reasonCode: string | null;
  type: CollectionType;
  /** Set at the door; null until the collection has an outcome. */
  qtyCollected?: number | null;
  diffReason?: string | null;
  diffNote?: string | null;
  /** Handed over but not on the sheet. */
  isExtra?: boolean;
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
  /** Lines of this invoice the customer refused — see lib/stop-removal.ts. */
  rejectedLines?: TripRejectedLine[];
}

export interface TripRejectedLine {
  id: string;
  description: string;
  quantity: number | null;
  reason: string;
  recordedBy: string;
  createdAt: Date;
}

/** An invoice taken off this run before it was signed — see RemovedStop. */
export interface TripRemovedStop {
  id: string;
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  source: string;
  reason: string;
  removedBy: string;
  removedAt: Date;
  keptForCollections: boolean;
}

/** A collection taken off this run before the driver got to it — see RemovedCollection. */
export interface TripRemovedCollection {
  id: string;
  stopNumber: number;
  collectionNo: string;
  customerName: string;
  reason: string;
  removedBy: string;
  removedAt: Date;
  stopRemoved: boolean;
}

/** A stop moved between drivers' runs — see ReallocatedStop. */
export interface TripReallocation {
  id: string;
  fromTripSheetId: string;
  toTripSheetId: string;
  fromDriverName: string;
  toDriverName: string;
  fromStopNumber: number;
  toStopNumber: number;
  invoiceNumber: string;
  customerName: string;
  reason: string | null;
  reallocatedBy: string;
  reallocatedAt: Date;
}

/**
 * Whether a stop's delivery is finished. A stop with no invoice number has
 * nothing to deliver — a collection-only stop, or one whose invoice was taken
 * off the run — so only its collections decide it. Mirrors isStopDone on the
 * driver's run sheet.
 */
export function isDeliveryDone(stop: { invoiceNumber: string; status: string }): boolean {
  return !stop.invoiceNumber || stop.status === "SIGNED";
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
  /** Invoices the office took off this run before they were signed. */
  removedStops?: TripRemovedStop[];
  /** Collections the office took off this run before they were collected. */
  removedCollections?: TripRemovedCollection[];
  /** Stops moved off this run to another driver. */
  reallocatedOut?: TripReallocation[];
  /** Stops this run received from another driver's run. */
  reallocatedIn?: TripReallocation[];
}

/** One frozen stop inside a CompletedTripSheet.stops snapshot. */
export interface ArchivedStop {
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  address: string;
  nop: number;
  signedAt: string | null;
  /** Absent on snapshots taken before the signer's name was captured. */
  signedByName?: string | null;
  /** The signed PDF's filename, for resending. Absent on older snapshots. */
  invoiceFile?: string | null;
  emailStatus: string;
  /** Lines the customer refused. Absent on snapshots taken before rejections. */
  rejectedLines?: { description: string; quantity: number | null; reason: string }[];
  /** Resends from the archive that went out — not part of the frozen JSON;
   *  joined in from ArchivedEmailResend by getCompletedTripSheets. */
  resends?: number;
  lastResentAt?: string | null;
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
  /**
   * The Collection row, which outlives the trip (detached at completion).
   * Absent on snapshots taken before collections were kept.
   */
  collectionId?: string;
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
  /** Absent on snapshots taken before receipts were emailed. */
  emailStatus?: string | null;
  /** The driver recorded "Not as listed". Absent before confirm-by-exception. */
  hasVariance?: boolean;
  failReason?: string | null;
  /** Items on the sheet / items that came back; null when the sheet was never read. */
  itemsListed?: number | null;
  itemsCollected?: number | null;
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
  /** Invoices taken off this run before it closed. Joined from RemovedStop. */
  removedStops: TripRemovedStop[];
  /** Collections taken off this run before it closed. Joined from RemovedCollection. */
  removedCollections: TripRemovedCollection[];
  /** Stops handed to another driver before it closed. */
  reallocatedOut: TripReallocation[];
  /** Stops it took over from another driver's run. */
  reallocatedIn: TripReallocation[];
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
  const pattern = await readInvoiceNoPattern(tenantId);

  // Register every invoice this run touches BEFORE anything of the run is
  // written, so a failure here leaves no half-saved trip. Delivery invoices
  // come first (their row names the customer); a collection's invoice that is
  // not on file becomes a stub, so the chain still has an anchor.
  const knownCustomer = (name: string) => (name && name !== "Unknown" ? name : null);
  const invoiceIds = await ensureInvoices(
    tenantId,
    [
      ...trip.stops
        .filter((stop) => stop.invoiceNumber)
        .map((stop) => ({
          invoiceNo: stop.invoiceNumber,
          pdfFilename: stop.invoiceFile ?? null,
          customerName: knownCustomer(stop.customerName),
        })),
      ...trip.stops.flatMap((stop) =>
        (stop.collections ?? [])
          .filter((c) => c.originalInvoiceNo)
          .map((c) => ({
            invoiceNo: c.originalInvoiceNo!,
            pdfFilename: c.originalInvoiceFile ?? null,
            customerName: knownCustomer(stop.customerName),
            stubIfNew: true,
          }))
      ),
    ],
    pattern
  );

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
          invoiceNoNormalized: normalizedInvoiceNoOrNull(stop.invoiceNumber, pattern),
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
      invoiceNoNormalized: normalizedInvoiceNoOrNull(collection.originalInvoiceNo, pattern),
      invoiceId:
        invoiceIds.get(normalizedInvoiceNoOrNull(collection.originalInvoiceNo, pattern) ?? "") ?? null,
      exceptionReason: null,
      expectedQty: collection.expectedQty ?? null,
      sourceFileId: collection.sourceFileId ?? null,
      sourceFilePath: collection.sourceFilePath ?? null,
      // Copied now so the row still names its customer after completion has
      // detached it from the stop.
      customerName: stop.customerName || null,
      tripSheetId: created.id,
      stopId: stopIdByNumber.get(stop.stopNumber)!,
    }))
  );

  // Date and customer off each new invoice's PDF, after the response.
  scheduleInvoiceHeaders(tenantId, { ids: [...invoiceIds.values()], limit: 50 });

  let collections: Awaited<ReturnType<typeof db.collection.findMany>> = [];
  if (collectionRows.length > 0) {
    await db.collection.createMany({ data: collectionRows });
    // Each collection's office sheet, read into lines after the response.
    scheduleCollectionSheets(tenantId, { tripSheetIds: [created.id], minIntervalMs: 0 });
    collections = await db.collection.findMany({
      where: { tripSheetId: created.id },
      orderBy: { collectionNo: "asc" },
    });
  }

  const collectionsByStop = new Map<string, typeof collections>();
  for (const collection of collections) {
    if (!collection.stopId) continue; // just created on this trip — always attached
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
        collections: {
          orderBy: { collectionNo: "asc" },
          // The office sheet's lines: small, never priced, read by the trip view.
          include: { lines: { orderBy: { lineNo: "asc" } } },
        },
        // Lines the customer refused — the driver must not hand them over.
        rejectedLines: { orderBy: { createdAt: "asc" } },
      },
    }),
  ]);

  const driverMap = new Map(drivers.map((d) => [d.id, d]));
  const [removedByTrip, realloc, removedCollectionsByTrip] = await Promise.all([
    loadRemovedStops(tenantId, trips.map((t) => t.id)),
    loadReallocations(tenantId, trips.map((t) => t.id)),
    loadRemovedCollections(tenantId, trips.map((t) => t.id)),
  ]);
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
      removedStops: removedByTrip.get(t.id) ?? [],
      removedCollections: removedCollectionsByTrip.get(t.id) ?? [],
      reallocatedOut: realloc.out.get(t.id) ?? [],
      reallocatedIn: realloc.inbound.get(t.id) ?? [],
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
        collections: {
          orderBy: { collectionNo: "asc" },
          // The office sheet's lines: small, never priced, read by the trip view.
          include: { lines: { orderBy: { lineNo: "asc" } } },
        },
        // Lines the customer refused — the driver must not hand them over.
        rejectedLines: { orderBy: { createdAt: "asc" } },
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
    removedStops: (await loadRemovedStops(tenantId, [trip.id])).get(trip.id) ?? [],
    ...(await loadReallocations(tenantId, [trip.id]).then((r) => ({
      reallocatedOut: r.out.get(trip.id) ?? [],
      reallocatedIn: r.inbound.get(trip.id) ?? [],
    }))),
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
        collections: {
          orderBy: { collectionNo: "asc" },
          // The office sheet's lines: small, never priced, read by the trip view.
          include: { lines: { orderBy: { lineNo: "asc" } } },
        },
        // Lines the customer refused — the driver must not hand them over.
        rejectedLines: { orderBy: { createdAt: "asc" } },
      },
    }),
  ]);

  const stopsByTrip = new Map<string, typeof allStops>();
  for (const stop of allStops) {
    const existing = stopsByTrip.get(stop.tripSheetId) || [];
    existing.push(stop);
    stopsByTrip.set(stop.tripSheetId, existing);
  }

  // The driver is told which stops the office took off and why — otherwise
  // they simply vanish, and a run whose rest was rejected looks unfinished
  // rather than done. Keyed to this driver's own trip ids.
  const [removedByTrip, realloc] = await Promise.all([
    loadRemovedStops(tenantId, trips.map((t) => t.id)),
    loadReallocations(tenantId, trips.map((t) => t.id)),
  ]);

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
    removedStops: removedByTrip.get(t.id) ?? [],
    reallocatedOut: realloc.out.get(t.id) ?? [],
    reallocatedIn: realloc.inbound.get(t.id) ?? [],
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

/** Longest signer name kept; the PDF stamp has one line for it. */
export const SIGNER_NAME_MAX = 80;

/**
 * Tidy the name a customer typed beside their signature: trimmed, inner
 * whitespace collapsed, capped. Blank reads as "not given" (null).
 */
export function normalizeSignerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, SIGNER_NAME_MAX);
  return name || null;
}

/**
 * Update a stop's status. A stop id from another scope is "not found".
 */
export async function updateStopStatus(
  tenantId: string,
  stopId: string,
  status: StopStatus,
  signatureData?: string,
  signedByName?: string | null
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
        ...(status === "SIGNED" && signedByName && { signedByName }),
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

    // Verify every delivery is signed. A stop with no invoice number has
    // nothing to sign (collection-only, or its invoice was taken off the run)
    // — it used to count as unsigned forever, so such a trip could never close.
    const [stops, removedCount, reallocatedCount, removedCollectionCount] = await Promise.all([
      db.stop.findMany({
        where: { tripSheetId: tripId },
        orderBy: { stopNumber: "asc" },
        include: { rejectedLines: { orderBy: { createdAt: "asc" } } },
      }),
      db.removedStop.count({ where: { tripSheetId: tripId } }),
      db.reallocatedStop.count({ where: { fromTripSheetId: tripId } }),
      db.removedCollection.count({ where: { tripSheetId: tripId } }),
    ]);

    const unsigned = stops.filter((s) => !isDeliveryDone(s));
    // A run emptied by rejections, by removed collections or by handing its
    // stops to another driver still has a trip to close out: those records
    // are its history.
    if (
      unsigned.length > 0 ||
      (stops.length === 0 && removedCount + reallocatedCount + removedCollectionCount === 0)
    ) {
      return {
        success: false,
        error:
          stops.length === 0
            ? "Cannot complete: this trip sheet has no stops"
            : `Cannot complete: ${unsigned.length} stop(s) are not yet signed`,
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
      include: { lines: { select: { qtyListed: true, qtyCollected: true, isExtra: true } } },
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

    // Snapshot, detach and delete in ONE transaction. Deleting the sheet is
    // what keeps finished stops out of every driver's run sheet and out of the
    // change-feed cursor; the snapshot is the day's record (frozen as JSON, so
    // later edits to a driver or contact cannot rewrite what was delivered).
    // Together, so a failure cannot leave a snapshot of a trip that is still
    // live, and a second completion of the same trip rolls back whole rather
    // than archiving it twice.
    //
    // Collections are DETACHED, not deleted: a credit note references the
    // invoice and arrives after the trip has gone, so the rows must outlive
    // it. Clearing tripSheetId/stopId is what lets the delete below pass them
    // by instead of cascading through them.
    const archive = await db.$transaction(async (tx) => {
    const snapshot = await tx.completedTripSheet.create({
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
          signedByName: s.signedByName,
          invoiceFile: s.invoiceFile,
          emailStatus: s.emailStatus,
          // Frozen with the stop: the credit note for a refused line is raised
          // after the trip closes, and the RejectedLine rows cascade away.
          ...(s.rejectedLines.length > 0 && {
            rejectedLines: s.rejectedLines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              reason: l.reason,
            })),
          }),
        })),
        // Frozen for the same reason the stops are: this is what the archive
        // view and the credit-return report show of the day. The rows
        // themselves now live on (detached below) for credit matching; the
        // collectionId ties each frozen entry to its row. Signed PDFs stay in
        // Collections/Signed permanently.
        collections: collections.map((c) => {
          const stop = c.stopId ? stopById.get(c.stopId) : undefined;
          return {
            collectionId: c.id,
            collectionNo: c.collectionNo,
            type: c.type,
            upliftSubtype: c.upliftSubtype,
            originalInvoiceNo: c.originalInvoiceNo,
            status: c.status,
            exceptionReason: c.exceptionReason,
            notes: c.notes,
            expectedQty: c.expectedQty,
            collectedQty: c.collectedQty,
            customerName: stop?.customerName ?? c.customerName ?? "Unknown",
            stopNumber: stop?.stopNumber ?? null,
            signedByName: c.signedByName,
            collectedAt: c.collectedAt ? c.collectedAt.toISOString() : null,
            sourceFilePath: c.sourceFilePath,
            signedFileId: c.signedFileId,
            signedFilePath: c.signedFilePath,
            emailStatus: c.emailStatus,
            hasVariance: c.hasVariance,
            failReason: c.failReason,
            ...lineTotals(c.lines),
          };
        }),
      },
    });

    if (collections.length > 0) {
      // The customer, for rows deployed before it was copied onto them —
      // after the detach there is no stop left to read it from.
      for (const stop of stops) {
        await tx.collection.updateMany({
          where: { stopId: stop.id, customerName: null },
          data: { customerName: stop.customerName },
        });
      }
      // The signed PDF is the record of the signature; the PNG is the bulk
      // of the row. Kept only where filing failed, so the office can still
      // produce the document by hand.
      await tx.collection.updateMany({
        where: { tripSheetId: tripId, signedFilePath: { not: null } },
        data: { signature: null },
      });
      await tx.collection.updateMany({
        where: { tripSheetId: tripId },
        data: { tripSheetId: null, stopId: null, completedTripSheetId: snapshot.id },
      });
    }

    // Cascades to the stops; the collections were detached above.
    await tx.tripSheet.delete({ where: { id: tripId } });
    return snapshot;
    });

    // Originals the signed copies now fully contain. After the commit, and
    // best-effort: a leftover file is harmless, the archive is already safe.
    const settled = await removeSettledOriginals(
      tenantId,
      collections.map((c) => c.id)
    );

    await logAudit({
      action: "STATUS_CHANGE",
      entity: "trip_sheet",
      entityId: tripId,
      userName: trip.uploadedBy,
      details: `Trip sheet completed for driver ${driver?.name || "Unknown"} (${stops.length} stops, all signed${
        collections.length ? `; ${collections.length} collections closed out` : ""
      }${removedCount ? `; ${removedCount} invoice(s) removed before signing` : ""}${
        reallocatedCount ? `; ${reallocatedCount} stop(s) reallocated to another driver` : ""
      }${
        settled.removed.length ? `; ${settled.removed.length} settled collection original(s) removed from Pending` : ""
      }; archive ${archive.id})${
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

  // Resends that went out, per archived stop. Kept beside the snapshot rather
  // than written into it: the archive is frozen.
  const resends = rows.length
    ? await db.archivedEmailResend.findMany({
        where: { completedTripSheetId: { in: rows.map((r) => r.id) }, sentAt: { not: null } },
        select: { completedTripSheetId: true, stopNumber: true, sentAt: true },
      })
    : [];
  // RemovedStop rows outlive the sheet and keep its old id, so the archive
  // finds them by tripSheetId the same way the live view does.
  const [removedByTrip, realloc, removedCollectionsByTrip] = await Promise.all([
    loadRemovedStops(tenantId, rows.map((r) => r.tripSheetId)),
    loadReallocations(tenantId, rows.map((r) => r.tripSheetId)),
    loadRemovedCollections(tenantId, rows.map((r) => r.tripSheetId)),
  ]);
  const resendsByStop = new Map<string, { count: number; last: Date }>();
  for (const r of resends) {
    const key = `${r.completedTripSheetId}:${r.stopNumber}`;
    const prev = resendsByStop.get(key);
    resendsByStop.set(key, {
      count: (prev?.count ?? 0) + 1,
      last: prev && prev.last > r.sentAt! ? prev.last : r.sentAt!,
    });
  }

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
    stops: (Array.isArray(r.stops) ? (r.stops as unknown as ArchivedStop[]) : []).map(
      (s) => {
        const sent = resendsByStop.get(`${r.id}:${s.stopNumber}`);
        return {
          ...s,
          resends: sent?.count ?? 0,
          lastResentAt: sent ? sent.last.toISOString() : null,
        };
      }
    ),
    // Null on every trip archived before collections existed, which reads
    // correctly as "this trip had none".
    collections: Array.isArray(r.collections)
      ? (r.collections as unknown as ArchivedCollection[])
      : [],
    removedStops: removedByTrip.get(r.tripSheetId) ?? [],
    removedCollections: removedCollectionsByTrip.get(r.tripSheetId) ?? [],
    reallocatedOut: realloc.out.get(r.tripSheetId) ?? [],
    reallocatedIn: realloc.inbound.get(r.tripSheetId) ?? [],
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
  rejectedLines?: TripRejectedLine[] | null;
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
    rejectedLines: stop.rejectedLines
      ? stop.rejectedLines.map((l) => ({
          id: l.id,
          description: l.description,
          quantity: l.quantity,
          reason: l.reason,
          recordedBy: l.recordedBy,
          createdAt: l.createdAt,
        }))
      : undefined,
  };
}

/**
 * Reallocations touching these runs, from both ends: `out` keyed by the run
 * the stops left, `inbound` by the run that received them. One query.
 */
async function loadReallocations(
  tenantId: string,
  tripSheetIds: string[]
): Promise<{ out: Map<string, TripReallocation[]>; inbound: Map<string, TripReallocation[]> }> {
  const out = new Map<string, TripReallocation[]>();
  const inbound = new Map<string, TripReallocation[]>();
  if (tripSheetIds.length === 0) return { out, inbound };

  const rows = await scopedPrisma(tenantId).reallocatedStop.findMany({
    where: {
      OR: [{ fromTripSheetId: { in: tripSheetIds } }, { toTripSheetId: { in: tripSheetIds } }],
    },
    orderBy: [{ reallocatedAt: "asc" }, { toStopNumber: "asc" }],
  });
  const ids = new Set(tripSheetIds);
  for (const r of rows) {
    const item: TripReallocation = {
      id: r.id,
      fromTripSheetId: r.fromTripSheetId,
      toTripSheetId: r.toTripSheetId,
      fromDriverName: r.fromDriverName,
      toDriverName: r.toDriverName,
      fromStopNumber: r.fromStopNumber,
      toStopNumber: r.toStopNumber,
      invoiceNumber: r.invoiceNumber,
      customerName: r.customerName,
      reason: r.reason,
      reallocatedBy: r.reallocatedBy,
      reallocatedAt: r.reallocatedAt,
    };
    if (ids.has(r.fromTripSheetId)) {
      out.set(r.fromTripSheetId, [...(out.get(r.fromTripSheetId) ?? []), item]);
    }
    if (ids.has(r.toTripSheetId)) {
      inbound.set(r.toTripSheetId, [...(inbound.get(r.toTripSheetId) ?? []), item]);
    }
  }
  return { out, inbound };
}

/** Invoices taken off these runs, grouped by trip sheet, oldest first. */
async function loadRemovedStops(
  tenantId: string,
  tripSheetIds: string[]
): Promise<Map<string, TripRemovedStop[]>> {
  const byTrip = new Map<string, TripRemovedStop[]>();
  if (tripSheetIds.length === 0) return byTrip;

  const rows = await scopedPrisma(tenantId).removedStop.findMany({
    where: { tripSheetId: { in: tripSheetIds } },
    orderBy: { removedAt: "asc" },
  });
  for (const r of rows) {
    const list = byTrip.get(r.tripSheetId) ?? [];
    list.push({
      id: r.id,
      stopNumber: r.stopNumber,
      invoiceNumber: r.invoiceNumber,
      customerName: r.customerName,
      source: r.source,
      reason: r.reason,
      removedBy: r.removedBy,
      removedAt: r.removedAt,
      keptForCollections: r.keptForCollections,
    });
    byTrip.set(r.tripSheetId, list);
  }
  return byTrip;
}

/** RemovedCollection rows by the trip they were taken off — live or archived. */
async function loadRemovedCollections(
  tenantId: string,
  tripSheetIds: string[]
): Promise<Map<string, TripRemovedCollection[]>> {
  const byTrip = new Map<string, TripRemovedCollection[]>();
  if (tripSheetIds.length === 0) return byTrip;

  const rows = await scopedPrisma(tenantId).removedCollection.findMany({
    where: { tripSheetId: { in: tripSheetIds } },
    orderBy: { removedAt: "asc" },
  });
  for (const r of rows) {
    const list = byTrip.get(r.tripSheetId) ?? [];
    list.push({
      id: r.id,
      stopNumber: r.stopNumber,
      collectionNo: r.collectionNo,
      customerName: r.customerName,
      reason: r.reason,
      removedBy: r.removedBy,
      removedAt: r.removedAt,
      stopRemoved: r.stopRemoved,
    });
    byTrip.set(r.tripSheetId, list);
  }
  return byTrip;
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
  sheetStatus?: "MISSING" | "READY" | "NEEDS_REVIEW";
  sheetIssues?: unknown;
  lines?: TripCollectionLine[];
  hasVariance?: boolean;
  failReason?: string | null;
  sheetError?: string | null;
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
    sheetStatus: collection.sheetStatus,
    sheetIssues: Array.isArray(collection.sheetIssues)
      ? (collection.sheetIssues as TripCollection["sheetIssues"])
      : null,
    lines: collection.lines?.map((l) => ({
      lineNo: l.lineNo,
      itemCode: l.itemCode,
      shortName: l.shortName,
      description: l.description,
      qtyListed: l.qtyListed,
      reasonCode: l.reasonCode,
      type: l.type,
      qtyCollected: l.qtyCollected,
      diffReason: l.diffReason,
      diffNote: l.diffNote,
      isExtra: l.isExtra,
    })),
    hasVariance: collection.hasVariance,
    failReason: collection.failReason,
    sheetError: collection.sheetError,
  };
}

/**
 * Items listed on the office's sheet and items that came back. Null when the
 * sheet was never read, so readers fall back to the box count.
 */
function lineTotals(
  lines: { qtyListed: number; qtyCollected: number | null; isExtra: boolean }[]
): { itemsListed: number | null; itemsCollected: number | null } {
  if (lines.length === 0) return { itemsListed: null, itemsCollected: null };
  const anyCollected = lines.some((l) => l.qtyCollected !== null);
  return {
    itemsListed: lines.filter((l) => !l.isExtra).reduce((n, l) => n + l.qtyListed, 0),
    itemsCollected: anyCollected ? lines.reduce((n, l) => n + (l.qtyCollected ?? 0), 0) : null,
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
  /** Whether the customer's receipt went out. Null on old archive snapshots. */
  emailStatus: string | null;
  /** Live rows only — the archive keeps the outcome, not the transport error. */
  emailError: string | null;
  /** The live trip sheet, or the archived trip's original id. */
  tripSheetId: string;
  /** True when this came out of a CompletedTripSheet snapshot. */
  archived: boolean;
  /** The archive row it came from, for linking back to the completed trip. */
  completedTripSheetId: string | null;
  /** The driver recorded "Not as listed" — what came back differs from the sheet. */
  hasVariance: boolean;
  /**
   * Items on the office's sheet, and items that came back — null when the
   * sheet was never read (then expectedQty / collectedQty are the box count).
   */
  itemsListed: number | null;
  itemsCollected: number | null;
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
      // Live only. Archived rows (detached at completion) are reported from
      // the frozen snapshot below, exactly as before they were kept — reading
      // them here too would list every closed-out collection twice.
      tripSheetId: { not: null },
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
      lines: { select: { qtyListed: true, qtyCollected: true, isExtra: true } },
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
    customerName: c.stop?.customerName ?? c.customerName ?? "Unknown",
    stopNumber: c.stop?.stopNumber ?? null,
    signedByName: c.signedByName,
    collectedAt: c.collectedAt,
    sourceFilePath: c.sourceFilePath,
    signedFileId: c.signedFileId,
    signedFilePath: c.signedFilePath,
    driverId: c.tripSheet?.driverId ?? c.driverId,
    driverName: c.tripSheet?.driver?.name ?? null,
    hasVariance: c.hasVariance,
    ...lineTotals(c.lines),
    emailStatus: c.emailStatus,
    emailError: c.emailError,
    // Filtered to attached rows above.
    tripSheetId: c.tripSheetId!,
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
        emailStatus: c.emailStatus ?? null,
        emailError: null,
        tripSheetId: archive.tripSheetId,
        archived: true,
        completedTripSheetId: archive.id,
        hasVariance: c.hasVariance ?? false,
        itemsListed: c.itemsListed ?? null,
        itemsCollected: c.itemsCollected ?? null,
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

// ─── Normalized invoice numbers ───────────────────────────────────────────

/**
 * Bring this scope's stored invoiceNoNormalized values in line with its
 * current pattern: after the pattern changes in Settings, and from the
 * backfill for rows written before the column existed.
 *
 * Only live rows carry the column — completed trips are archived as JSON and
 * their readers normalize the raw value on the fly. That keeps this small: a
 * scope's live stops and collections, not its history.
 *
 * Updates are keyed on the RAW value, not on row ids: every row holding
 * "INV-2026-1047" gets that value's normalization. A row whose invoice number
 * changes underneath (a stop taken off its run has it blanked) is therefore
 * never handed a value computed from what it used to hold. No transaction:
 * rows are independent, and a run cut short converges when run again.
 *
 * @param apply false counts what would change and writes nothing.
 */
export async function renormalizeInvoiceNumbers(
  tenantId: string,
  pattern: InvoiceNoPattern,
  { apply = true }: { apply?: boolean } = {}
): Promise<{ stops: number; collections: number; invoices: number; invoiceConflicts: number }> {
  const db = scopedPrisma(tenantId);

  const [stops, collections, invoices] = await Promise.all([
    db.stop.findMany({ select: { invoiceNumber: true, invoiceNoNormalized: true } }),
    db.collection.findMany({ select: { originalInvoiceNo: true, invoiceNoNormalized: true } }),
    db.invoice.findMany({ select: { id: true, invoiceNo: true, invoiceNoNormalized: true } }),
  ]);

  // The invoice registry is keyed on the normalized number, so a new pattern
  // can make two rows claim one number. Those are left as they are and
  // counted: merging them would re-point collections, which is a decision for
  // a person, not a settings save.
  const invoiceChanges = invoices
    .map((inv) => ({ ...inv, next: normalizeInvoiceNo(inv.invoiceNo, pattern) }))
    .filter((inv) => inv.next && inv.next !== inv.invoiceNoNormalized);
  let invoiceConflicts = 0;
  if (apply) {
    await mapWithConcurrency(
      invoiceChanges,
      async (inv) => {
        try {
          await db.invoice.update({ where: { id: inv.id }, data: { invoiceNoNormalized: inv.next } });
        } catch (err) {
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
            invoiceConflicts++;
          } else {
            throw err;
          }
        }
      },
      4
    );
  }

  /** raw value → its normalization, for every raw value with a row that disagrees */
  const stale = <T>(rows: T[], raw: (r: T) => string | null, stored: (r: T) => string | null) => {
    const changes = new Map<string, string | null>();
    let count = 0;
    for (const row of rows) {
      const value = raw(row) ?? "";
      const next = normalizedInvoiceNoOrNull(value, pattern);
      if (next !== stored(row)) {
        changes.set(value, next);
        count++;
      }
    }
    return { changes, count };
  };

  const stopChanges = stale(stops, (s) => s.invoiceNumber, (s) => s.invoiceNoNormalized);
  const collectionChanges = stale(
    collections,
    (c) => c.originalInvoiceNo,
    (c) => c.invoiceNoNormalized
  );

  if (apply) {
    await mapWithConcurrency(
      [...stopChanges.changes],
      ([raw, next]) =>
        db.stop.updateMany({ where: { invoiceNumber: raw }, data: { invoiceNoNormalized: next } }),
      4
    );
    await mapWithConcurrency(
      [...collectionChanges.changes],
      ([raw, next]) =>
        db.collection.updateMany({
          // A blank originalInvoiceNo is stored as null; "" never reaches the DB.
          where: { originalInvoiceNo: raw === "" ? null : raw },
          data: { invoiceNoNormalized: next },
        }),
      4
    );
  }

  return {
    stops: stopChanges.count,
    collections: collectionChanges.count,
    invoices: invoiceChanges.length - invoiceConflicts,
    invoiceConflicts,
  };
}
