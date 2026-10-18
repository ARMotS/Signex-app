/**
 * Keep each collection's lines in step with the office's sheet.
 *
 *   • At deploy, every collection on the new run is checked for its sheet.
 *   • Until the trip starts, sheets are re-checked — the office often saves a
 *     sheet AFTER the trip sheet went out, or re-saves a corrected one. There
 *     is no scheduler, so the re-check rides on pages that are already polling
 *     (the trip sheet page, the driver's run), throttled per collection.
 *   • An ADMIN can attach a sheet by hand, re-read one, or approve one that
 *     needs review (app/api/collections/[id]/sheet).
 *
 * The sheet is the source of truth for what the driver brings back. Once the
 * trip has started the lines are frozen against automatic re-reads, so a
 * re-saved sheet cannot change what a driver at the door is holding.
 */

import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import {
  buildCollectionLookup,
  listCollectionFolder,
  matchCollectionDocument,
  readCollectionDocument,
  type CollectionDocument,
} from "./collections";
import { assessSheet, readCollectionSheet, type SheetIssue } from "./collection-sheet";
import { readInvoiceNoPattern } from "./config";
import { mapWithConcurrency } from "./concurrency";
import { logAudit } from "./audit";

/** Minimum gap between automatic looks at one collection's sheet. */
export const SHEET_RECHECK_MS = 3 * 60 * 1000;

export type SheetLoadResult =
  | { outcome: "read"; status: "READY" | "NEEDS_REVIEW"; issues: SheetIssue[]; lines: number }
  | { outcome: "not_found" | "closed" | "missing" }
  | { outcome: "error"; error: string };

/**
 * Read one collection's sheet and replace its lines.
 *
 * @param doc The document, when the caller has already listed the folder.
 *   Otherwise the recorded sourceFilePath is read.
 */
export async function loadCollectionSheet(
  tenantId: string,
  collectionId: string,
  { doc, by }: { doc?: CollectionDocument; by?: string } = {}
): Promise<SheetLoadResult> {
  const db = scopedPrisma(tenantId);
  const collection = await db.collection.findFirst({
    where: { id: collectionId },
    include: { stop: { select: { customerName: true } } },
  });
  if (!collection) return { outcome: "not_found" };
  // Archived, or the driver has already recorded an outcome: what was
  // collected is settled, and the lines it was collected against stay put.
  if (!collection.tripSheetId || collection.status !== "PENDING") return { outcome: "closed" };

  const filename = doc?.filename ?? collection.sourceFilePath;
  if (!filename) return { outcome: "missing" };

  let parsed: Awaited<ReturnType<typeof readCollectionSheet>>;
  try {
    const pdf = await readCollectionDocument(tenantId, filename);
    if (!pdf) {
      await db.collection.updateMany({
        where: { id: collectionId },
        data: { sheetCheckedAt: new Date(), sheetError: `${filename} could not be read from the collections folder` },
      });
      return { outcome: "missing" };
    }
    parsed = await readCollectionSheet(pdf);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.collection.updateMany({
      where: { id: collectionId },
      data: { sheetCheckedAt: new Date(), sheetError: error },
    });
    return { outcome: "error", error };
  }

  const pattern = await readInvoiceNoPattern(tenantId);
  const assessment = assessSheet(
    parsed.sheet,
    {
      collectionNo: collection.collectionNo,
      invoiceNoNormalized: collection.invoiceNoNormalized,
      customerName: collection.stop?.customerName ?? collection.customerName,
      isUplift: collection.type === "NON_CREDIT_UPLIFT",
    },
    parsed.source,
    pattern
  );

  const now = new Date();
  const { lines, ...header } = parsed.sheet;
  const written = await db.$transaction(async (tx) => {
    // Conditional on the collection still being open: a driver recording the
    // outcome at this moment wins, and the lines they collected against stay.
    const claim = await tx.collection.updateMany({
      where: { id: collectionId, status: "PENDING", tripSheetId: { not: null } },
      data: {
        sheetStatus: assessment.status,
        sheetIssues: assessment.issues as unknown as Prisma.InputJsonValue,
        sheetHeader: header as unknown as Prisma.InputJsonValue,
        sheetSource: parsed.source,
        sheetReadAt: now,
        sheetCheckedAt: now,
        sheetError: null,
        sheetReviewedBy: null,
        sheetReviewedAt: null,
        sourceFilePath: filename,
        ...(doc?.itemId && { sourceFileId: doc.itemId }),
        ...(doc && { sheetFileModified: new Date(doc.lastModified) }),
      },
    });
    if (claim.count === 0) return false;

    await tx.collectionLine.deleteMany({ where: { collectionId } });
    if (lines.length > 0) {
      await tx.collectionLine.createMany({
        data: lines.map((l) => ({
          collectionId,
          lineNo: l.lineNo,
          itemCode: l.itemCode,
          shortName: l.shortName,
          description: l.description,
          qtyListed: l.qtyListed,
          qtyReturnedPrinted: l.qtyReturnedPrinted,
          reasonCode: l.reasonCode,
          type: assessment.lineType,
        })),
      });
    }
    return true;
  });
  if (!written) return { outcome: "closed" };

  await logAudit({
    action: "UPLOAD",
    entity: "collection",
    entityId: collectionId,
    userName: by ?? "system",
    details: `Collection sheet ${filename} read for ${collection.collectionNo}: ${lines.length} line(s), ${
      assessment.status
    }${assessment.issues.length ? ` — ${assessment.issues.map((i) => i.code).join(", ")}` : ""}`,
    tenantId,
  });

  return { outcome: "read", status: assessment.status, issues: assessment.issues, lines: lines.length };
}

/** Trips that have started: any stop past PENDING, or any collection with an outcome. */
async function startedTrips(tenantId: string, tripSheetIds: string[]): Promise<Set<string>> {
  if (tripSheetIds.length === 0) return new Set();
  const db = scopedPrisma(tenantId);
  const [stops, collections] = await Promise.all([
    db.stop.findMany({
      where: { tripSheetId: { in: tripSheetIds }, status: { not: "PENDING" } },
      select: { tripSheetId: true },
      distinct: ["tripSheetId"],
    }),
    db.collection.findMany({
      where: { tripSheetId: { in: tripSheetIds }, status: { not: "PENDING" } },
      select: { tripSheetId: true },
      distinct: ["tripSheetId"],
    }),
  ]);
  return new Set([...stops.map((s) => s.tripSheetId), ...collections.map((c) => c.tripSheetId!)]);
}

/**
 * Look for sheets that have arrived or changed, on trips that have not
 * started. One folder listing per run, however many collections are waiting.
 *
 * Throttled per collection by sheetCheckedAt, and each collection is claimed
 * by moving that timestamp conditionally, so two pages polling at once do not
 * both read the same sheet.
 */
export async function refreshCollectionSheets(
  tenantId: string,
  {
    tripSheetIds,
    minIntervalMs = SHEET_RECHECK_MS,
    limit = 30,
  }: { tripSheetIds?: string[]; minIntervalMs?: number; limit?: number } = {}
): Promise<{ checked: number; read: number }> {
  const db = scopedPrisma(tenantId);
  const due = new Date(Date.now() - minIntervalMs);

  const candidates = await db.collection.findMany({
    where: {
      tripSheetId: tripSheetIds ? { in: tripSheetIds } : { not: null },
      status: "PENDING",
      OR: [{ sheetCheckedAt: null }, { sheetCheckedAt: { lt: due } }],
    },
    select: {
      id: true,
      collectionNo: true,
      tripSheetId: true,
      sheetStatus: true,
      sheetCheckedAt: true,
      sheetFileModified: true,
      sourceFilePath: true,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  if (candidates.length === 0) return { checked: 0, read: 0 };

  const started = await startedTrips(tenantId, [...new Set(candidates.map((c) => c.tripSheetId!))]);
  const open = candidates.filter((c) => !started.has(c.tripSheetId!));
  if (open.length === 0) return { checked: 0, read: 0 };

  // Claim before the (Graph) listing: whoever moves sheetCheckedAt owns it.
  const now = new Date();
  const claimed: typeof open = [];
  for (const c of open) {
    const res = await db.collection.updateMany({
      where: {
        id: c.id,
        ...(c.sheetCheckedAt ? { sheetCheckedAt: c.sheetCheckedAt } : { sheetCheckedAt: null }),
      },
      data: { sheetCheckedAt: now },
    });
    if (res.count === 1) claimed.push(c);
  }
  if (claimed.length === 0) return { checked: 0, read: 0 };

  const listing = await listCollectionFolder(tenantId);
  if (listing.error) return { checked: claimed.length, read: 0 };
  const lookup = buildCollectionLookup(listing.documents);
  const byFilename = new Map(listing.documents.map((d) => [d.filename.toLowerCase(), d]));

  let read = 0;
  await mapWithConcurrency(
    claimed,
    async (c) => {
      // The document already recorded wins over a fresh match, so an office
      // that attached a sheet by hand is not overridden by a lookalike name.
      const doc =
        (c.sourceFilePath && byFilename.get(c.sourceFilePath.toLowerCase())) ||
        matchCollectionDocument(lookup, c.collectionNo);
      if (!doc) return;

      const changed =
        c.sheetStatus === "MISSING" ||
        !c.sheetFileModified ||
        new Date(doc.lastModified).getTime() > c.sheetFileModified.getTime();
      if (!changed) return;

      const result = await loadCollectionSheet(tenantId, c.id, { doc });
      if (result.outcome === "read") read++;
    },
    3
  );

  return { checked: claimed.length, read };
}

/**
 * Re-check sheets after the response has gone. Never inline: it may list the
 * folder over Graph and download PDFs, and the page that triggered it must not
 * wait. Without a request scope (scripts, tests) it does nothing.
 */
export function scheduleCollectionSheets(
  tenantId: string,
  opts: { tripSheetIds?: string[]; minIntervalMs?: number } = {}
): void {
  try {
    after(() =>
      refreshCollectionSheets(tenantId, opts).catch((err) =>
        console.error(`Collection sheet re-check failed for scope ${tenantId}:`, err)
      )
    );
  } catch {
    // No request scope.
  }
}
