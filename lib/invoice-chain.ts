/**
 * The invoice chain: an invoice, its delivery, the collections credited
 * against it, and the credit notes that paid for them — and one status that
 * says where the chain stands.
 *
 *   INV · 1007 · 12/08/2026 · Randburg SIM Depot
 *   ├─ Delivered    trip · driver · signed
 *   ├─ Collection   CR · C005 · collected 2 · approved
 *   │   └─ Credit   CN · 5530 · R 1,150.00 · signed
 *   └─ Balance      Collected 2 · Credited 2 · Outstanding 0
 *
 * Signex holds invoices as PDFs, not lines, so the balance is per item that
 * came back: collected (from the collection lines), credited (what signed
 * credit notes froze at signing), outstanding. There is no "invoiced" column.
 *
 * chainStatus is pure — the Invoices tab computes it for a whole page of
 * invoices at once, the chain page for one.
 */

import { scopedPrisma } from "./db-scoped";
import { normalizeInvoiceNo } from "./invoice-number";
import { readInvoiceNoPattern } from "./config";

export type ChainStatus =
  | "NOT_DELIVERED"
  | "DELIVERED"
  | "COLLECTION_PENDING"
  | "AWAITING_CREDIT"
  | "PARTIALLY_CREDITED"
  | "FULLY_CREDITED"
  | "EXCEPTION";

export const CHAIN_STATUS_LABEL: Record<ChainStatus, string> = {
  NOT_DELIVERED: "Not delivered",
  DELIVERED: "Delivered",
  COLLECTION_PENDING: "Collection pending",
  AWAITING_CREDIT: "Awaiting credit",
  PARTIALLY_CREDITED: "Partially credited",
  FULLY_CREDITED: "Fully credited",
  EXCEPTION: "Exception",
};

export interface ChainCollectionFacts {
  id: string;
  type: string;
  status: string;
  creditReview: string | null;
  collectedQty: number | null;
  lines: { id: string; qtyCollected: number | null; type: string }[];
}

export interface ChainFacts {
  delivered: boolean;
  collections: ChainCollectionFacts[];
  /** Credit notes on this invoice, by status. */
  creditNoteStatuses: string[];
  /** Quantity SIGNED credit notes paid for, per collection line id. */
  creditedByLine: Map<string, number>;
  /** Collections a signed credit note is linked to (for collections with no lines). */
  creditedCollectionIds: Set<string>;
}

/**
 * Where the chain stands. In order: an exception (a credit return rejected
 * for credit, a collection that failed at the door, a credit note needing
 * review, or more credited than came back) wins; then a collection still to
 * do; then how much of what came back has been credited; else delivered or not.
 */
export function chainStatus(f: ChainFacts): ChainStatus {
  const crs = f.collections.filter((c) => c.type === "CREDIT_RETURN");
  const back = crs.filter((c) => (c.status === "COLLECTED" || c.status === "PARTIAL") && c.creditReview !== "REJECTED");

  let collected = 0;
  let credited = 0;
  let overCredited = false;
  for (const c of back) {
    const lines = c.lines.filter((l) => l.type === "CREDIT_RETURN");
    if (lines.length === 0) {
      // No sheet lines: all or nothing, by whether a signed note pays for it.
      collected += 1;
      if (f.creditedCollectionIds.has(c.id)) credited += 1;
      continue;
    }
    for (const l of lines) {
      const got = l.qtyCollected ?? 0;
      const paid = f.creditedByLine.get(l.id) ?? 0;
      collected += got;
      credited += Math.min(paid, got);
      if (paid > got) overCredited = true;
    }
  }

  const exception =
    crs.some((c) => c.creditReview === "REJECTED" || c.status === "NOT_AVAILABLE" || c.status === "REFUSED") ||
    f.creditNoteStatuses.includes("NEEDS_REVIEW") ||
    overCredited;
  if (exception) return "EXCEPTION";
  if (crs.some((c) => c.status === "PENDING")) return "COLLECTION_PENDING";
  if (collected > 0) {
    if (credited === 0) return "AWAITING_CREDIT";
    return credited < collected ? "PARTIALLY_CREDITED" : "FULLY_CREDITED";
  }
  return f.delivered ? "DELIVERED" : "NOT_DELIVERED";
}

/** The tint a chain status wears on the Invoices tab. */
export function chainTone(status: ChainStatus): "idle" | "green" | "amber" | "violet" | "red" | "blue" {
  switch (status) {
    case "DELIVERED": return "green";
    case "COLLECTION_PENDING": return "amber";
    case "AWAITING_CREDIT": return "violet";
    case "PARTIALLY_CREDITED": return "amber";
    case "FULLY_CREDITED": return "blue";
    case "EXCEPTION": return "red";
    default: return "idle";
  }
}

// ─── A page of invoices at once (the Invoices tab) ───────────────────────

/**
 * The chain status of each invoice, in two queries for the whole page.
 * `delivered` says which have a signed copy filed.
 */
export async function chainStatuses(
  tenantId: string,
  invoiceIds: string[],
  delivered: Map<string, boolean>
): Promise<Map<string, ChainStatus>> {
  const result = new Map<string, ChainStatus>();
  if (invoiceIds.length === 0) return result;
  const db = scopedPrisma(tenantId);

  const [collections, notes] = await Promise.all([
    db.collection.findMany({
      where: { invoiceId: { in: invoiceIds } },
      select: {
        id: true,
        invoiceId: true,
        type: true,
        status: true,
        creditReview: true,
        collectedQty: true,
        lines: { select: { id: true, qtyCollected: true, type: true } },
      },
    }),
    db.creditNote.findMany({
      where: { invoiceId: { in: invoiceIds }, status: { not: "REJECTED" } },
      select: {
        invoiceId: true,
        status: true,
        allocations: { select: { collectionLineId: true, qty: true } },
        collections: { where: { source: { in: ["AUTO", "MANUAL"] } }, select: { collectionId: true } },
      },
    }),
  ]);

  for (const id of invoiceIds) {
    const mine = notes.filter((n) => n.invoiceId === id);
    const creditedByLine = new Map<string, number>();
    const creditedCollectionIds = new Set<string>();
    for (const n of mine.filter((n) => n.status === "SIGNED")) {
      for (const a of n.allocations) {
        creditedByLine.set(a.collectionLineId, (creditedByLine.get(a.collectionLineId) ?? 0) + Number(a.qty));
      }
      for (const l of n.collections) creditedCollectionIds.add(l.collectionId);
    }
    result.set(
      id,
      chainStatus({
        delivered: delivered.get(id) ?? false,
        collections: collections.filter((c) => c.invoiceId === id),
        creditNoteStatuses: mine.map((n) => n.status),
        creditedByLine,
        creditedCollectionIds,
      })
    );
  }
  return result;
}

// ─── One invoice, the whole chain (the invoice page) ─────────────────────

export interface ChainBalanceRow {
  item: string;
  description: string;
  collected: number;
  credited: number;
  outstanding: number;
}

/** Collected, credited and outstanding per item, across this invoice's credit returns. */
export function chainBalance(
  lines: { id: string; itemCode: string | null; description: string; qtyCollected: number | null; type: string }[],
  creditedByLine: Map<string, number>
): ChainBalanceRow[] {
  const rows = new Map<string, ChainBalanceRow>();
  for (const l of lines) {
    if (l.type !== "CREDIT_RETURN") continue;
    const key = (l.itemCode ?? l.description).trim().toUpperCase();
    const row = rows.get(key) ?? { item: l.itemCode ?? "—", description: l.description, collected: 0, credited: 0, outstanding: 0 };
    row.collected += l.qtyCollected ?? 0;
    row.credited += creditedByLine.get(l.id) ?? 0;
    rows.set(key, row);
  }
  return [...rows.values()].map((r) => ({ ...r, outstanding: Math.max(0, r.collected - r.credited) }));
}

/**
 * Everything on one invoice's chain, in this scope only. Null when the
 * invoice is not this scope's.
 */
export async function loadInvoiceChain(tenantId: string, invoiceId: string) {
  const db = scopedPrisma(tenantId);
  const invoice = await db.invoice.findFirst({ where: { id: invoiceId } });
  if (!invoice) return null;
  const pattern = await readInvoiceNoPattern(tenantId);
  const byInvoice = { OR: [{ invoiceId: invoice.id }, { invoiceNoNormalized: invoice.invoiceNoNormalized }] };

  const [liveStops, collections, notes] = await Promise.all([
    db.stop.findMany({
      where: { invoiceNoNormalized: invoice.invoiceNoNormalized },
      select: {
        id: true,
        status: true,
        signedAt: true,
        signedByName: true,
        invoiceFile: true,
        stopNumber: true,
        tripSheet: { select: { id: true, date: true, sourceFilename: true, driver: { select: { name: true } } } },
      },
    }),
    db.collection.findMany({
      where: byInvoice,
      include: { lines: { orderBy: { lineNo: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
    db.creditNote.findMany({
      where: byInvoice,
      include: {
        allocations: true,
        collections: { where: { source: { in: ["AUTO", "MANUAL"] } }, select: { collectionId: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // Closed-out deliveries live in the completed-trip archive as JSON. Looked
  // up by the raw numbers this invoice has been seen under, then confirmed by
  // normalizing each archived stop's number under the current pattern.
  const candidates = [
    ...new Set([invoice.invoiceNo, invoice.pdfFilename?.replace(/\.pdf$/i, ""), invoice.invoiceNoNormalized].filter(
      (v): v is string => !!v
    )),
  ];
  const archives = await db.completedTripSheet.findMany({
    where: { OR: candidates.map((v) => ({ stops: { array_contains: [{ invoiceNumber: v }] } })) },
    select: { id: true, driverName: true, uploadedAt: true, completedAt: true, sourceFilename: true, stops: true },
    orderBy: { completedAt: "desc" },
    take: 10,
  });
  const archivedStops = archives.flatMap((a) =>
    ((a.stops as unknown as { invoiceNumber: string; stopNumber: number; signedAt: string | null; signedByName?: string | null; invoiceFile?: string | null }[]) ?? [])
      .filter((s) => s.invoiceNumber && normalizeInvoiceNo(s.invoiceNumber, pattern) === invoice.invoiceNoNormalized)
      .map((s) => ({
        archiveId: a.id,
        driverName: a.driverName,
        tripDate: a.uploadedAt,
        completedAt: a.completedAt,
        sourceFilename: a.sourceFilename,
        stopNumber: s.stopNumber,
        signedAt: s.signedAt,
        signedByName: s.signedByName ?? null,
      }))
  );

  const creditedByLine = new Map<string, number>();
  const creditedCollectionIds = new Set<string>();
  for (const n of notes.filter((n) => n.status === "SIGNED")) {
    for (const a of n.allocations) {
      creditedByLine.set(a.collectionLineId, (creditedByLine.get(a.collectionLineId) ?? 0) + Number(a.qty));
    }
    for (const l of n.collections) creditedCollectionIds.add(l.collectionId);
  }

  const delivered =
    liveStops.some((s) => s.status === "SIGNED") || archivedStops.some((s) => !!s.signedAt);
  const status = chainStatus({
    delivered,
    collections,
    creditNoteStatuses: notes.filter((n) => n.status !== "REJECTED").map((n) => n.status),
    creditedByLine,
    creditedCollectionIds,
  });

  return {
    invoice,
    status,
    deliveries: {
      live: liveStops,
      archived: archivedStops,
    },
    collections,
    creditNotes: notes,
    balance: chainBalance(collections.filter((c) => c.creditReview !== "REJECTED").flatMap((c) => c.lines), creditedByLine),
  };
}
