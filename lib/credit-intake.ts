/**
 * Credit notes in: from the branch's credits folder (or an upload) into
 * CreditNote rows, linked to the invoice they credit and the collections whose
 * goods they pay for.
 *
 *   • The accounting software writes each note to the branch's credits folder
 *     (Originals/, or straight into the folder). There is no scheduler, so the
 *     folder is checked while the Credits page is open (throttled per scope)
 *     and on "Check folder".
 *   • Each new PDF is read (lib/credit-note.ts), and the note is matched to its
 *     invoice by the invoice number it prints — it never prints a collection
 *     number — then to that invoice's collected collections, on quantities.
 *   • A second note with a credit number already received is REJECTED and its
 *     file moved to Rejected/. The unique claim on creditNoClaim makes that
 *     hold even when two copies are picked up at the same moment.
 *   • Notes waiting to be signed are re-checked on every look, because what
 *     they are checked against moves: a collection gets collected, another
 *     note is received.
 *
 * Signing (the sign-off page, Signed/) is the next step and lives elsewhere.
 * OneDrive only: a local folder path does not exist on the hosted app.
 */

import { after } from "next/server";
import { Prisma, type CreditNoteStatus } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import {
  assessCreditNote,
  matchCreditLines,
  readCreditNote,
  type CollectedLine,
  type CreditIssue,
  type LineMatch,
  type ParsedCreditNote,
} from "./credit-note";
import { readInvoiceNoPattern, readVatRate } from "./config";
import { normalizeInvoiceNo, normalizedInvoiceNoOrNull } from "./invoice-number";
import {
  downloadFileById,
  listOneDriveCreditNotes,
  moveCreditNoteFile,
  uploadCreditNoteOriginal,
} from "./microsoft-graph";
import { mapWithConcurrency } from "./concurrency";
import { logAudit } from "./audit";

/** Minimum gap between automatic looks at one scope's credits folder. */
export const CREDITS_RECHECK_MS = 60 * 1000;
/** PDFs read per look — each is a download and a parse (a scan, a Claude call). */
const READS_PER_LOOK = 10;

const LIVE: CreditNoteStatus[] = ["RECEIVED", "NEEDS_REVIEW"];

export interface CreditFile {
  itemId: string;
  filename: string;
  subfolder: "Originals" | "root";
  lastModified: string | null;
}

export type IngestResult =
  | { outcome: "read"; id: string; status: CreditNoteStatus; issues: CreditIssue[] }
  | { outcome: "duplicate"; id: string; duplicateOf: string }
  | { outcome: "closed"; id: string };

const num = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d));

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Read one credit note PDF into its row, and check it.
 *
 * Re-reading a file already held replaces its header and lines — unless the
 * note has been signed or rejected, which settles it.
 */
export async function ingestCreditNote(
  tenantId: string,
  file: CreditFile,
  buffer: Buffer,
  { uploadedBy, by }: { uploadedBy?: string; by?: string } = {}
): Promise<IngestResult> {
  const db = scopedPrisma(tenantId);
  const existing = await db.creditNote.findFirst({
    where: { sourceItemId: file.itemId },
    select: { id: true, status: true },
  });
  if (existing && !LIVE.includes(existing.status)) return { outcome: "closed", id: existing.id };

  let note: ParsedCreditNote | null = null;
  let source: "TEXT" | "AI" | null = null;
  let readError: string | null = null;
  try {
    ({ note, source } = await readCreditNote(buffer));
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err);
  }

  const pattern = await readInvoiceNoPattern(tenantId);
  const creditNoNormalized = note?.creditNo ? normalizeInvoiceNo(note.creditNo) || null : null;
  const fields = {
    creditNo: note?.creditNo ?? null,
    creditNoNormalized,
    invoiceNo: note?.invoiceNo ?? null,
    invoiceNoNormalized: normalizedInvoiceNoOrNull(note?.invoiceNo, pattern),
    creditDate: note?.creditDate ? new Date(`${note.creditDate}T00:00:00Z`) : null,
    accountNo: note?.accountNo ?? null,
    deliverToName: note?.deliverToName ?? null,
    billToName: note?.billToName ?? null,
    subtotal: note?.subtotal ?? null,
    vatAmount: note?.vatAmount ?? null,
    total: note?.total ?? null,
    readSource: source,
    readAt: new Date(),
    readError,
    sourceItemId: file.itemId,
    sourceFilename: file.filename,
    sourceFolder: file.subfolder,
    sourceModifiedAt: file.lastModified ? new Date(file.lastModified) : null,
    fileError: null,
  };
  const readFailed: CreditIssue[] = readError
    ? [{ code: "READ_FAILED", level: "review", message: `The credit note could not be read: ${readError}` }]
    : [];

  /** Another live note already holding this credit number, if any. */
  const holderOf = async (excludeId: string | null) =>
    creditNoNormalized
      ? db.creditNote.findFirst({
          where: { creditNoClaim: creditNoNormalized, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
          select: { id: true, creditNo: true, sourceFilename: true },
        })
      : null;

  const write = (claim: string | null, extra: { status: CreditNoteStatus; issues: CreditIssue[]; rejectReason?: string }) =>
    db.$transaction(async (tx) => {
      let id: string;
      if (existing) {
        // Signed or rejected between the read above and now: leave it.
        const res = await tx.creditNote.updateMany({
          where: { id: existing.id, status: { in: LIVE } },
          data: { ...fields, creditNoClaim: claim, status: extra.status, issues: extra.issues as unknown as Prisma.InputJsonValue, rejectReason: extra.rejectReason ?? null },
        });
        if (res.count === 0) return null;
        id = existing.id;
      } else {
        const row = await tx.creditNote.create({
          data: {
            ...fields,
            creditNoClaim: claim,
            status: extra.status,
            issues: extra.issues as unknown as Prisma.InputJsonValue,
            rejectReason: extra.rejectReason ?? null,
            uploadedBy: uploadedBy ?? null,
          },
          select: { id: true },
        });
        id = row.id;
      }
      await tx.creditNoteLine.deleteMany({ where: { creditNoteId: id } });
      if (note && note.lines.length > 0) {
        await tx.creditNoteLine.createMany({
          data: note.lines.map((l) => ({
            creditNoteId: id,
            lineNo: l.lineNo,
            productCode: l.productCode,
            shortName: l.shortName,
            bin: l.bin,
            description: l.description,
            qty: l.qty,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct,
            nett: l.nett,
          })),
        });
      }
      return id;
    });

  const rejectAsDuplicate = async (holder: { id: string; creditNo: string | null; sourceFilename: string }) => {
    const message = `Credit note ${note?.creditNo ?? holder.creditNo} was already received (${holder.sourceFilename}).`;
    const id = await write(null, {
      status: "REJECTED",
      issues: [{ code: "DUPLICATE", level: "review", message }],
      rejectReason: message,
    });
    if (!id) return { outcome: "closed" as const, id: existing!.id };
    await fileAway(tenantId, id, file, "rejected");
    await logAudit({
      action: "STATUS_CHANGE",
      entity: "credit_note",
      entityId: id,
      userName: by ?? uploadedBy ?? "system",
      details: JSON.stringify({ event: "credit_note_rejected", reason: "DUPLICATE", duplicateOf: holder.id, file: file.filename }),
      tenantId,
    });
    return { outcome: "duplicate" as const, id, duplicateOf: holder.id };
  };

  const holder = await holderOf(existing?.id ?? null);
  if (holder) return rejectAsDuplicate(holder);

  let id: string | null;
  try {
    id = await write(creditNoNormalized, { status: "NEEDS_REVIEW", issues: readFailed });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Two copies picked up at once: whoever took the claim first keeps it.
    const winner = await holderOf(existing?.id ?? null);
    if (!winner) throw err; // the same file, ingested twice at once
    return rejectAsDuplicate(winner);
  }
  if (!id) return { outcome: "closed", id: existing!.id };

  await logAudit({
    action: "UPLOAD",
    entity: "credit_note",
    entityId: id,
    userName: by ?? uploadedBy ?? "system",
    details: JSON.stringify({ event: existing ? "credit_note_reread" : "credit_note_received", creditNo: fields.creditNo, invoiceNo: fields.invoiceNo, file: file.filename }),
    tenantId,
  });

  if (readError) return { outcome: "read", id, status: "NEEDS_REVIEW", issues: readFailed };
  const assessed = await reassessCreditNote(tenantId, id);
  return { outcome: "read", id, status: assessed?.status ?? "NEEDS_REVIEW", issues: assessed?.issues ?? [] };
}

/** Move a note's file to Rejected/ (or Signed/), recording where it went or why it did not. */
export async function fileAway(tenantId: string, id: string, file: CreditFile, to: "rejected" | "signed") {
  const db = scopedPrisma(tenantId);
  try {
    await moveCreditNoteFile(tenantId, file.itemId, to, file.filename);
    await db.creditNote.update({ where: { id }, data: { sourceFolder: to === "rejected" ? "Rejected" : "Signed", fileError: null } });
  } catch (err) {
    await db.creditNote.update({
      where: { id },
      data: { fileError: `Could not move the file to ${to === "rejected" ? "Rejected" : "Signed"}/: ${err instanceof Error ? err.message : String(err)}` },
    });
  }
}

// ─── Checking a note against what was collected ──────────────────────────

export interface CreditEvaluation {
  status: CreditNoteStatus;
  issues: CreditIssue[];
  matches: LineMatch[];
}

/**
 * Re-link a live note to its invoice's collected collections and check it
 * again. AUTO links follow the invoice; MANUAL ones (the office's) stay; an
 * AUTO link the office took away (EXCLUDED) is never put back.
 *
 * Null for a note that is not live (signed or rejected) or not in this scope.
 */
export async function reassessCreditNote(tenantId: string, creditNoteId: string): Promise<CreditEvaluation | null> {
  const db = scopedPrisma(tenantId);
  const note = await db.creditNote.findFirst({
    where: { id: creditNoteId },
    include: { lines: { orderBy: { lineNo: "asc" } }, collections: true },
  });
  if (!note || !LIVE.includes(note.status)) return null;
  if (note.readError) {
    return { status: note.status, issues: (note.issues as unknown as CreditIssue[]) ?? [], matches: [] };
  }

  const invoice = note.invoiceNoNormalized
    ? await db.invoice.findFirst({
        where: { invoiceNoNormalized: note.invoiceNoNormalized },
        select: { id: true, invoiceNo: true, customerName: true },
      })
    : null;

  const against = note.invoiceNoNormalized
    ? await db.collection.findMany({
        where: {
          type: "CREDIT_RETURN",
          OR: [{ invoiceNoNormalized: note.invoiceNoNormalized }, ...(invoice ? [{ invoiceId: invoice.id }] : [])],
        },
        select: { id: true, collectionNo: true, status: true, creditReview: true, creditReviewReason: true },
      })
    : [];

  // A collection the office rejected for credit is never linked: it stays on
  // record, but nothing is credited against it.
  const linkOf = new Map(note.collections.map((l) => [l.collectionId, l]));
  const wantAuto = against.filter(
    (c) =>
      (c.status === "COLLECTED" || c.status === "PARTIAL") &&
      c.creditReview !== "REJECTED" &&
      linkOf.get(c.id)?.source !== "EXCLUDED"
  );
  const wantIds = new Set(wantAuto.map((c) => c.id));
  const staleAuto = note.collections.filter((l) => l.source === "AUTO" && !wantIds.has(l.collectionId));
  const newAuto = wantAuto.filter((c) => !linkOf.has(c.id));
  if (staleAuto.length > 0 || newAuto.length > 0) {
    await db.$transaction(async (tx) => {
      if (staleAuto.length > 0) {
        await tx.creditNoteCollection.deleteMany({ where: { id: { in: staleAuto.map((l) => l.id) }, source: "AUTO" } });
      }
      if (newAuto.length > 0) {
        await tx.creditNoteCollection.createMany({
          data: newAuto.map((c) => ({ creditNoteId: note.id, collectionId: c.id, source: "AUTO" })),
          skipDuplicates: true,
        });
      }
    });
  }

  const linkedIds = [
    ...new Set([
      ...wantAuto.map((c) => c.id),
      ...note.collections.filter((l) => l.source === "MANUAL").map((l) => l.collectionId),
    ]),
  ];
  const linkedRows = linkedIds.length
    ? await db.collection.findMany({
        where: { id: { in: linkedIds } },
        select: { id: true, collectionNo: true, lines: true, creditReview: true, creditReviewReason: true },
        orderBy: { collectedAt: "asc" },
      })
    : [];
  // A MANUAL link to a collection rejected since stops counting too.
  const linked = linkedRows.filter((c) => c.creditReview !== "REJECTED");
  const rejected = new Map<string, { collectionNo: string; reason: string | null }>();
  for (const c of [...against.filter((c) => c.status === "COLLECTED" || c.status === "PARTIAL"), ...linkedRows]) {
    if (c.creditReview === "REJECTED") rejected.set(c.id, { collectionNo: c.collectionNo, reason: c.creditReviewReason });
  }
  const collectedLines: CollectedLine[] = linked.flatMap((c) =>
    c.lines.map((l) => ({
      id: l.id,
      collectionId: c.id,
      collectionNo: c.collectionNo,
      itemCode: l.itemCode,
      shortName: l.shortName,
      description: l.description,
      qtyCollected: l.qtyCollected ?? 0,
      type: l.type,
    }))
  );

  // What other notes already pay for out of these collections: signed ones
  // (what they were frozen at, at signing), then live ones received before
  // this one. Later notes yield to earlier.
  const alreadyCredited = new Map<string, number>();
  const lineIds = collectedLines.map((l) => l.id);
  if (lineIds.length > 0) {
    const signed = await db.creditNoteAllocation.findMany({
      where: { collectionLineId: { in: lineIds }, creditNoteId: { not: note.id }, creditNote: { status: "SIGNED" } },
      select: { collectionLineId: true, qty: true },
    });
    for (const a of signed) {
      alreadyCredited.set(a.collectionLineId, (alreadyCredited.get(a.collectionLineId) ?? 0) + Number(a.qty));
    }
  }
  const others = linkedIds.length
    ? await db.creditNote.findMany({
        where: {
          id: { not: note.id },
          collections: { some: { collectionId: { in: linkedIds }, source: { in: ["AUTO", "MANUAL"] } } },
          status: { in: LIVE },
          createdAt: { lt: note.createdAt },
        },
        include: { lines: { orderBy: { lineNo: "asc" } } },
        orderBy: { createdAt: "asc" },
      })
    : [];
  for (const other of others) {
    const m = matchCreditLines(
      other.lines.map((l) => ({ ...l, qty: Number(l.qty) })),
      collectedLines,
      alreadyCredited
    );
    for (const a of m.flatMap((x) => x.allocations)) {
      alreadyCredited.set(a.collectionLineId, (alreadyCredited.get(a.collectionLineId) ?? 0) + a.qty);
    }
  }

  const parsed: ParsedCreditNote = {
    creditNo: note.creditNo,
    invoiceNo: note.invoiceNo,
    creditDate: note.creditDate ? note.creditDate.toISOString().slice(0, 10) : null,
    accountNo: note.accountNo,
    deliverToName: note.deliverToName,
    billToName: note.billToName,
    lines: note.lines.map((l) => ({
      lineNo: l.lineNo,
      productCode: l.productCode,
      shortName: l.shortName,
      bin: l.bin,
      description: l.description,
      qty: Number(l.qty),
      unitPrice: num(l.unitPrice),
      discountPct: num(l.discountPct),
      nett: num(l.nett),
    })),
    subtotal: num(note.subtotal),
    vatAmount: num(note.vatAmount),
    total: num(note.total),
  };

  const result = assessCreditNote(
    parsed,
    {
      vatRate: await readVatRate(tenantId),
      invoice: invoice ? { invoiceNo: invoice.invoiceNo, customerName: invoice.customerName } : null,
      collections: linked.map((c) => ({ id: c.id, collectionNo: c.collectionNo, hasLines: c.lines.length > 0 })),
      pendingCollectionNos: against.filter((c) => c.status === "PENDING").map((c) => c.collectionNo),
      collectedLines,
      alreadyCredited,
      rejectedCollections: [...rejected.values()],
      // Decided on the Collections tab, before or after the trip closes.
      unapprovedCollectionNos: linked.filter((c) => !c.creditReview).map((c) => c.collectionNo),
    },
    note.readSource === "AI" ? "AI" : "TEXT"
  );

  await db.creditNote.updateMany({
    where: { id: note.id, status: { in: LIVE } },
    data: {
      status: result.status,
      issues: result.issues as unknown as Prisma.InputJsonValue,
      invoiceId: invoice?.id ?? null,
    },
  });
  return result;
}

// ─── The folder ──────────────────────────────────────────────────────────

export type CreditSyncResult =
  | { outcome: "not_configured" | "throttled" }
  | { outcome: "error"; error: string }
  | { outcome: "checked"; inFolder: number; read: number; duplicates: number; waiting: number };

/**
 * Look at the credits folder: read new (or re-saved) PDFs, notice files that
 * have gone, and re-check every note waiting to be signed.
 *
 * Throttled per scope through a claim on CloudAccount.creditsCheckedAt, so a
 * page open on several screens costs one listing, not one each.
 */
export async function syncCreditsFolder(
  tenantId: string,
  { minIntervalMs = CREDITS_RECHECK_MS, by }: { minIntervalMs?: number; by?: string } = {}
): Promise<CreditSyncResult> {
  const db = scopedPrisma(tenantId);
  const account = await db.cloudAccount.findFirst({
    where: { provider: "onedrive" },
    select: { id: true, creditsFolderItemId: true, creditsCheckedAt: true },
  });
  if (!account?.creditsFolderItemId) return { outcome: "not_configured" };

  if (account.creditsCheckedAt && Date.now() - account.creditsCheckedAt.getTime() < minIntervalMs) {
    return { outcome: "throttled" };
  }
  const claim = await db.cloudAccount.updateMany({
    where: { id: account.id, creditsCheckedAt: account.creditsCheckedAt },
    data: { creditsCheckedAt: new Date() },
  });
  if (claim.count === 0) return { outcome: "throttled" };

  let items;
  try {
    items = (await listOneDriveCreditNotes(tenantId)) ?? [];
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.cloudAccount.updateMany({ where: { id: account.id }, data: { creditsError: error } });
    return { outcome: "error", error };
  }
  await db.cloudAccount.updateMany({ where: { id: account.id, creditsError: { not: null } }, data: { creditsError: null } });

  const known = await db.creditNote.findMany({
    where: { sourceItemId: { in: items.map((i) => i.id) } },
    select: { id: true, sourceItemId: true, status: true, sourceModifiedAt: true, sourceFolder: true, sourceFilename: true, fileError: true },
  });
  const byItem = new Map(known.map((k) => [k.sourceItemId, k]));

  const due = items.filter((item) => {
    const k = byItem.get(item.id);
    if (!k) return true;
    if (!LIVE.includes(k.status)) return false;
    return !k.sourceModifiedAt || new Date(item.lastModifiedDateTime).getTime() > k.sourceModifiedAt.getTime();
  });

  // Known notes whose file moved between Originals/ and the root, or came back.
  for (const item of items) {
    const k = byItem.get(item.id);
    if (!k || due.includes(item)) continue;
    if (LIVE.includes(k.status) && (k.sourceFolder !== item.creditsSubfolder || k.sourceFilename !== item.name || k.fileError)) {
      await db.creditNote.update({
        where: { id: k.id },
        data: { sourceFolder: item.creditsSubfolder, sourceFilename: item.name, fileError: null },
      });
    }
  }

  // Live notes whose file is no longer where the accounting software left it.
  const seen = new Set(items.map((i) => i.id));
  const gone = await db.creditNote.findMany({
    where: { status: { in: LIVE }, sourceFolder: { in: ["Originals", "root"] }, fileError: null },
    select: { id: true, sourceItemId: true },
  });
  for (const g of gone.filter((g) => !seen.has(g.sourceItemId))) {
    await db.creditNote.update({
      where: { id: g.id },
      data: { fileError: "The file is no longer in the credits folder — it was moved, renamed elsewhere or deleted." },
    });
  }

  let read = 0;
  let duplicates = 0;
  await mapWithConcurrency(
    due.slice(0, READS_PER_LOOK),
    async (item) => {
      try {
        const buffer = await downloadFileById(tenantId, item.id);
        const result = await ingestCreditNote(
          tenantId,
          { itemId: item.id, filename: item.name, subfolder: item.creditsSubfolder, lastModified: item.lastModifiedDateTime },
          buffer,
          { by }
        );
        if (result.outcome === "read") read++;
        if (result.outcome === "duplicate") duplicates++;
      } catch (err) {
        console.error(`Credit note ${item.name} could not be taken in for scope ${tenantId}:`, err);
      }
    },
    2
  );

  // Everything waiting to be signed is checked again: a collection may have
  // been collected, or an earlier note received, since it was last looked at.
  const waiting = await db.creditNote.findMany({
    where: { status: { in: LIVE }, readError: null },
    select: { id: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  for (const w of waiting) await reassessCreditNote(tenantId, w.id);

  return { outcome: "checked", inFolder: items.length, read, duplicates, waiting: Math.max(0, due.length - READS_PER_LOOK) };
}

/**
 * Look at the credits folder after the response has gone. Never inline: it
 * lists the folder over Graph and may download PDFs. Without a request scope
 * (scripts, tests) it does nothing.
 */
export function scheduleCreditsSync(tenantId: string): void {
  try {
    after(() =>
      syncCreditsFolder(tenantId).catch((err) =>
        console.error(`Credits folder check failed for scope ${tenantId}:`, err)
      )
    );
  } catch {
    // No request scope.
  }
}

// ─── Office actions ──────────────────────────────────────────────────────

export type UploadResult = IngestResult | { outcome: "conflict"; filename: string } | { outcome: "not_configured" };

/** "Upload credit note": store it in Originals/ and read it, as if the accounting software had. */
export async function uploadCreditNote(
  tenantId: string,
  filename: string,
  buffer: Buffer,
  uploadedBy: string
): Promise<UploadResult> {
  const db = scopedPrisma(tenantId);
  const account = await db.cloudAccount.findFirst({ where: { provider: "onedrive" }, select: { creditsFolderItemId: true } });
  if (!account?.creditsFolderItemId) return { outcome: "not_configured" };

  const item = await uploadCreditNoteOriginal(tenantId, filename, buffer);
  if (!item) return { outcome: "conflict", filename };
  return ingestCreditNote(
    tenantId,
    { itemId: item.id, filename: item.name ?? filename, subfolder: "Originals", lastModified: item.lastModifiedDateTime ?? null },
    buffer,
    { uploadedBy }
  );
}

/** Read a note's file again, whether or not it changed. */
export async function rereadCreditNote(tenantId: string, creditNoteId: string, by: string): Promise<IngestResult | { outcome: "not_found" } | { outcome: "error"; error: string }> {
  const db = scopedPrisma(tenantId);
  const note = await db.creditNote.findFirst({
    where: { id: creditNoteId },
    select: { id: true, status: true, sourceItemId: true, sourceFilename: true, sourceFolder: true, sourceModifiedAt: true },
  });
  if (!note) return { outcome: "not_found" };
  if (!LIVE.includes(note.status)) return { outcome: "closed", id: note.id };

  let buffer: Buffer;
  try {
    buffer = await downloadFileById(tenantId, note.sourceItemId);
  } catch (err) {
    return { outcome: "error", error: err instanceof Error ? err.message : String(err) };
  }
  return ingestCreditNote(
    tenantId,
    {
      itemId: note.sourceItemId,
      filename: note.sourceFilename,
      subfolder: note.sourceFolder === "root" ? "root" : "Originals",
      lastModified: note.sourceModifiedAt?.toISOString() ?? null,
    },
    buffer,
    { by }
  );
}

export type LinkResult =
  | { outcome: "linked" | "unlinked"; evaluation: CreditEvaluation | null }
  | { outcome: "not_found" | "closed" | "not_collected" | "rejected_collection" };

/**
 * The office links a collection the invoice did not lead to (a collection
 * booked against the wrong invoice, say), or takes away one that does not
 * belong. Only a collection that has come back — COLLECTED or PARTIAL — can be
 * paid for. Either id from another scope is not_found.
 */
export async function setCreditNoteLink(
  tenantId: string,
  creditNoteId: string,
  collectionId: string,
  linked: boolean,
  by: string
): Promise<LinkResult> {
  const db = scopedPrisma(tenantId);
  const [note, collection] = await Promise.all([
    db.creditNote.findFirst({ where: { id: creditNoteId }, select: { id: true, status: true } }),
    db.collection.findFirst({ where: { id: collectionId }, select: { id: true, status: true, type: true, collectionNo: true, creditReview: true } }),
  ]);
  if (!note || !collection) return { outcome: "not_found" };
  if (!LIVE.includes(note.status)) return { outcome: "closed" };

  const existing = await db.creditNoteCollection.findFirst({ where: { creditNoteId, collectionId } });
  if (linked) {
    if (collection.type !== "CREDIT_RETURN" || (collection.status !== "COLLECTED" && collection.status !== "PARTIAL")) {
      return { outcome: "not_collected" };
    }
    if (collection.creditReview === "REJECTED") return { outcome: "rejected_collection" };
    if (existing) {
      await db.creditNoteCollection.update({ where: { id: existing.id }, data: { source: "MANUAL", linkedBy: by } });
    } else {
      await db.creditNoteCollection.create({ data: { creditNoteId, collectionId, source: "MANUAL", linkedBy: by } });
    }
  } else if (existing) {
    // An AUTO link is kept as EXCLUDED, or the next check would put it back.
    if (existing.source === "MANUAL") await db.creditNoteCollection.delete({ where: { id: existing.id } });
    else await db.creditNoteCollection.update({ where: { id: existing.id }, data: { source: "EXCLUDED", linkedBy: by } });
  }

  await logAudit({
    action: "STATUS_CHANGE",
    entity: "credit_note",
    entityId: creditNoteId,
    userName: by,
    details: JSON.stringify({ event: linked ? "credit_note_linked" : "credit_note_unlinked", collectionId, collectionNo: collection.collectionNo }),
    tenantId,
  });

  return { outcome: linked ? "linked" : "unlinked", evaluation: await reassessCreditNote(tenantId, creditNoteId) };
}
