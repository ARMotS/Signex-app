/**
 * Rejected deliveries — taking an invoice off a live trip sheet, and recording
 * single lines of an invoice the customer refused.
 *
 * Two shapes of the same event at the door:
 *
 *   - The customer refuses the whole invoice (the wrong item was sent and it is
 *     the only thing on it). The stop comes off the driver's run. A RemovedStop
 *     row is written in the same transaction, because the Stop row is about to
 *     disappear and "it was on the run, and why it came off" must survive it.
 *
 *   - The customer refuses one line of a multi-line invoice. The stop stays;
 *     the refused line is recorded against it (RejectedLine), the driver sees
 *     it, and the customer signs for the rest. Signex holds invoices as PDFs,
 *     not line items, so the line is the dispatcher's description of it.
 *
 * Deleting an invoice PDF on the Invoices page takes its unsigned stops off the
 * run through the same path (source INVOICE_DELETED): a stop is never left on a
 * run without its PDF, which is the rule the import gate enforces too.
 *
 * Every function takes `tenantId` first and runs on the scoped client, so a
 * stop id from another scope is simply "not found".
 */

import { scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";

export const REMOVAL_REASON_MAX = 500;
export const REJECTED_DESCRIPTION_MAX = 200;
export const REJECTED_REASON_MAX = 300;
export const REJECTED_QUANTITY_MAX = 100_000;

export type RemovalSource = "REJECTED" | "INVOICE_DELETED";

/** What the Invoices page records when the dispatcher gives no reason. */
export const DEFAULT_INVOICE_DELETED_REASON = "Invoice deleted from the Invoices page";

function tidy(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/** A removal reason, tidied; null when blank. Required on every removal. */
export function normalizeRemovalReason(value: unknown): string | null {
  return tidy(value, REMOVAL_REASON_MAX) || null;
}

export interface RejectedLineInput {
  description: string;
  quantity: number | null;
  reason: string;
}

/**
 * Validate a rejected line as typed by the dispatcher. The description and the
 * reason are both required: accounts raises the credit note from them, and
 * "rejected" with nothing else is not something anyone can reconcile.
 */
export function parseRejectedLine(
  body: unknown
): { ok: true; line: RejectedLineInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const description = tidy(b.description, REJECTED_DESCRIPTION_MAX);
  if (!description) {
    return { ok: false, error: "Describe the line that was rejected (item or product code)" };
  }
  const reason = tidy(b.reason, REJECTED_REASON_MAX);
  if (!reason) {
    return { ok: false, error: "Give a reason for the rejection" };
  }

  let quantity: number | null = null;
  if (b.quantity !== undefined && b.quantity !== null && b.quantity !== "") {
    const n = typeof b.quantity === "number" ? b.quantity : Number(String(b.quantity).trim());
    if (!Number.isInteger(n) || n < 1 || n > REJECTED_QUANTITY_MAX) {
      return { ok: false, error: "Quantity must be a whole number of 1 or more" };
    }
    quantity = n;
  }

  return { ok: true, line: { description, quantity, reason } };
}

export type RemoveStopResult =
  | { outcome: "removed"; removedStopId: string; invoiceNumber: string }
  /** The stop stayed on the run for its collections; only the delivery came off. */
  | { outcome: "delivery_removed"; removedStopId: string; invoiceNumber: string }
  | { outcome: "not_found" }
  /** Signed already — a delivery the customer signed for is not "rejected". */
  | { outcome: "signed" }
  /** A collection-only stop has no invoice to remove. */
  | { outcome: "no_invoice" };

/**
 * Take one stop's invoice off its trip sheet.
 *
 * A stop that also carries collections is kept: the goods coming back still
 * have to be collected, so only the delivery is stripped (blank invoice number,
 * no PDF), which is exactly the shape of a collection-only stop.
 *
 * The decision is re-checked inside the transaction, conditional on the stop
 * still not being SIGNED. A driver can sign at the door while the dispatcher is
 * pressing Remove; whichever lands first wins, and a signed delivery is never
 * deleted from under the customer's signature.
 */
export async function removeStopFromTrip(
  tenantId: string,
  stopId: string,
  opts: { reason: string; removedBy: string; source: RemovalSource }
): Promise<RemoveStopResult> {
  const db = scopedPrisma(tenantId);

  const stop = await db.stop.findFirst({
    where: { id: stopId },
    include: {
      tripSheet: { select: { id: true, driverId: true } },
      _count: { select: { collections: true } },
    },
  });
  if (!stop) return { outcome: "not_found" };
  if (stop.status === "SIGNED") return { outcome: "signed" };
  if (!stop.invoiceNumber) return { outcome: "no_invoice" };

  const driver = await db.driver.findFirst({
    where: { id: stop.tripSheet.driverId },
    select: { name: true },
  });
  const keepForCollections = stop._count.collections > 0;

  const result = await db.$transaction(async (tx) => {
    const guard = { id: stopId, status: { not: "SIGNED" as const }, invoiceNumber: { not: "" } };

    const changed = keepForCollections
      ? await tx.stop.updateMany({
          where: guard,
          data: { invoiceNumber: "", invoiceFile: null, nop: 0 },
        })
      : await tx.stop.deleteMany({ where: guard });

    // Signed (or already removed) between the read above and now.
    if (changed.count === 0) return null;

    if (keepForCollections) {
      // Refused lines belonged to the delivery that has just come off.
      await tx.rejectedLine.deleteMany({ where: { stopId } });
    }

    return tx.removedStop.create({
      data: {
        tripSheetId: stop.tripSheet.id,
        driverId: stop.tripSheet.driverId,
        driverName: driver?.name ?? "Unknown",
        stopNumber: stop.stopNumber,
        invoiceNumber: stop.invoiceNumber,
        customerName: stop.customerName,
        address: stop.address,
        nop: stop.nop,
        invoiceFile: stop.invoiceFile,
        statusAtRemoval: stop.status,
        source: opts.source,
        reason: opts.reason,
        removedBy: opts.removedBy,
        keptForCollections: keepForCollections,
      },
      select: { id: true },
    });
  });

  if (!result) {
    const now = await db.stop.findFirst({ where: { id: stopId }, select: { status: true } });
    return now?.status === "SIGNED" ? { outcome: "signed" } : { outcome: "not_found" };
  }

  await logAudit({
    action: "STATUS_CHANGE",
    entity: "stop",
    entityId: stopId,
    userName: opts.removedBy,
    details: `Invoice ${stop.invoiceNumber} (${stop.customerName}) ${
      keepForCollections ? "delivery removed from stop" : "removed from trip sheet"
    } ${stop.stopNumber} for driver ${driver?.name ?? "Unknown"} — ${
      opts.source === "INVOICE_DELETED" ? "invoice PDF deleted" : "rejected"
    }: ${opts.reason}`,
    tenantId,
  });

  return {
    outcome: keepForCollections ? "delivery_removed" : "removed",
    removedStopId: result.id,
    invoiceNumber: stop.invoiceNumber,
  };
}

/** One live stop that uses an invoice PDF — what the Invoices page warns about. */
export interface InvoiceTripUsage {
  filename: string;
  stopId: string;
  tripSheetId: string;
  driverName: string;
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  status: string;
}

/**
 * Which live stops use these invoice files. Every trip sheet in the table is
 * live — completing one deletes it — so no status filter is needed.
 *
 * Matched case-insensitively: OneDrive and Windows filenames are, and a stop
 * whose PDF was deleted under a differently-cased name is no less stranded.
 */
export async function findInvoiceTripUsage(
  tenantId: string,
  filenames: string[]
): Promise<InvoiceTripUsage[]> {
  const names = [...new Set(filenames.filter((f) => typeof f === "string" && f))];
  if (names.length === 0) return [];
  const db = scopedPrisma(tenantId);

  const stops = await db.stop.findMany({
    where: {
      OR: names.map((name) => ({ invoiceFile: { equals: name, mode: "insensitive" as const } })),
    },
    orderBy: [{ tripSheetId: "asc" }, { stopNumber: "asc" }],
    select: {
      id: true,
      tripSheetId: true,
      stopNumber: true,
      invoiceNumber: true,
      customerName: true,
      status: true,
      invoiceFile: true,
      tripSheet: { select: { driver: { select: { name: true } } } },
    },
  });

  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  return stops.map((s) => ({
    filename: byLower.get((s.invoiceFile ?? "").toLowerCase()) ?? s.invoiceFile ?? "",
    stopId: s.id,
    tripSheetId: s.tripSheetId,
    driverName: s.tripSheet.driver?.name ?? "Unknown",
    stopNumber: s.stopNumber,
    invoiceNumber: s.invoiceNumber,
    customerName: s.customerName,
    status: s.status,
  }));
}

/**
 * Take every unsigned stop that uses these (now deleted) invoice files off its
 * run. Signed stops are left alone: the delivery happened, and whether its
 * paperwork is kept is a separate question from whether it was delivered.
 */
export async function removeStopsForDeletedInvoices(
  tenantId: string,
  filenames: string[],
  opts: { reason: string; removedBy: string }
): Promise<{ removed: InvoiceTripUsage[]; keptSigned: InvoiceTripUsage[] }> {
  const usage = await findInvoiceTripUsage(tenantId, filenames);
  const removed: InvoiceTripUsage[] = [];
  const keptSigned: InvoiceTripUsage[] = [];

  for (const u of usage) {
    if (u.status === "SIGNED") {
      keptSigned.push(u);
      continue;
    }
    const r = await removeStopFromTrip(tenantId, u.stopId, {
      reason: opts.reason,
      removedBy: opts.removedBy,
      source: "INVOICE_DELETED",
    });
    if (r.outcome === "removed" || r.outcome === "delivery_removed") removed.push(u);
    else if (r.outcome === "signed") keptSigned.push({ ...u, status: "SIGNED" });
  }

  return { removed, keptSigned };
}

export type RejectedLineResult =
  | { outcome: "recorded"; id: string }
  | { outcome: "not_found" }
  | { outcome: "signed" }
  | { outcome: "no_invoice" };

/**
 * Record one refused line against a stop. Refused once signed: the signed PDF
 * already says what was accepted, and a line recorded afterwards would be on
 * the record but not on the paper the customer signed.
 */
export async function addRejectedLine(
  tenantId: string,
  stopId: string,
  line: RejectedLineInput,
  recordedBy: string
): Promise<RejectedLineResult> {
  const db = scopedPrisma(tenantId);
  const stop = await db.stop.findFirst({
    where: { id: stopId },
    select: { id: true, status: true, invoiceNumber: true, stopNumber: true, customerName: true },
  });
  if (!stop) return { outcome: "not_found" };
  if (stop.status === "SIGNED") return { outcome: "signed" };
  if (!stop.invoiceNumber) return { outcome: "no_invoice" };

  const created = await db.$transaction(async (tx) => {
    // Bump the stop inside the same transaction, conditional on it still being
    // unsigned. That both closes the race with a driver signing, and moves the
    // stop's updatedAt — which is what the driver's sync cursor watches, so the
    // run sheet refreshes and shows the line.
    const touched = await tx.stop.updateMany({
      where: { id: stopId, status: { not: "SIGNED" }, invoiceNumber: { not: "" } },
      data: { updatedAt: new Date() },
    });
    if (touched.count === 0) return null;
    return tx.rejectedLine.create({
      data: { stopId, ...line, recordedBy },
      select: { id: true },
    });
  });
  if (!created) return { outcome: "signed" };

  await logAudit({
    action: "STATUS_CHANGE",
    entity: "stop",
    entityId: stopId,
    userName: recordedBy,
    details: `Line rejected on ${stop.invoiceNumber} (${stop.customerName}, stop ${stop.stopNumber}): ${
      line.quantity ? `${line.quantity} × ` : ""
    }${line.description} — ${line.reason}`,
    tenantId,
  });

  return { outcome: "recorded", id: created.id };
}

/** Undo a rejected line recorded in error. Same signed-stop rule as adding one. */
export async function deleteRejectedLine(
  tenantId: string,
  stopId: string,
  lineId: string,
  deletedBy: string
): Promise<{ outcome: "deleted" | "not_found" | "signed" }> {
  const db = scopedPrisma(tenantId);
  const line = await db.rejectedLine.findFirst({
    where: { id: lineId, stopId },
    select: { id: true, description: true, stop: { select: { status: true, invoiceNumber: true } } },
  });
  if (!line) return { outcome: "not_found" };
  if (line.stop.status === "SIGNED") return { outcome: "signed" };

  const done = await db.$transaction(async (tx) => {
    const touched = await tx.stop.updateMany({
      where: { id: stopId, status: { not: "SIGNED" } },
      data: { updatedAt: new Date() },
    });
    if (touched.count === 0) return false;
    await tx.rejectedLine.deleteMany({ where: { id: lineId, stopId } });
    return true;
  });
  if (!done) return { outcome: "signed" };

  await logAudit({
    action: "STATUS_CHANGE",
    entity: "stop",
    entityId: stopId,
    userName: deletedBy,
    details: `Rejected line withdrawn on ${line.stop.invoiceNumber}: ${line.description}`,
    tenantId,
  });
  return { outcome: "deleted" };
}

/** Rejected lines for one stop, oldest first — what the signed PDF and email print. */
export async function getRejectedLines(
  tenantId: string,
  stopId: string
): Promise<{ description: string; quantity: number | null; reason: string }[]> {
  return scopedPrisma(tenantId).rejectedLine.findMany({
    where: { stopId },
    orderBy: { createdAt: "asc" },
    select: { description: true, quantity: true, reason: true },
  });
}
