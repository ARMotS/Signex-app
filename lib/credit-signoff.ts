/**
 * Signing a credit note off, filing it, and rejecting one.
 *
 *   1. Sign: the dispatcher's own office login, their typed name and drawn
 *      signature, and — if the check found anything — a reason it is fine to
 *      sign anyway. One sign-off, no second approver (the client's decision).
 *      The record is written first, in one transaction with what the note pays
 *      for (CreditNoteAllocation), conditional on the note still being live:
 *      two dispatchers signing at once, one wins.
 *   2. File: the note with a SIGN-OFF page appended goes to Signed/ as
 *      CN{creditNo}_INV{invoiceNo}_COL{collectionNo}.pdf; then the unsigned
 *      original is removed from Originals/ (only when the signed copy really
 *      contains its pages); then each collection's signed receipt gets a
 *      CREDIT NOTE REFERENCE page. Each part is recorded as it completes, so a
 *      retry does only what is left. Nothing here can undo a signature — a
 *      failure is a filingError for the office, retried on the next look.
 *   3. Reject: a note the office will not sign (wrong customer, raised in
 *      error) leaves the queue with a reason and moves to Rejected/.
 */

import { Prisma, type CreditNoteStatus } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import { fileAway, reassessCreditNote, syncCreditsFolder } from "./credit-intake";
import type { CreditIssue } from "./credit-note";
import {
  appendCreditReference,
  buildSignedCreditNotePdf,
  signedCreditFilename,
  validateSignOff,
  type SignOffInput,
} from "./credit-signoff-pdf";
import { deleteFileById, downloadFileById, uploadSignedCreditNote } from "./microsoft-graph";
import { readSignedCollectionDocument, saveSignedCollection } from "./collections";
import { logAudit } from "./audit";
import { after } from "next/server";

const LIVE: CreditNoteStatus[] = ["RECEIVED", "NEEDS_REVIEW"];

export type SignResult =
  | { outcome: "signed"; filed: boolean; filingError: string | null }
  | { outcome: "not_found" | "closed" }
  | { outcome: "invalid"; error: string; issues?: CreditIssue[] };

export async function signCreditNote(
  tenantId: string,
  creditNoteId: string,
  input: SignOffInput,
  by: { name: string; userId: string }
): Promise<SignResult> {
  const db = scopedPrisma(tenantId);
  const note = await db.creditNote.findFirst({
    where: { id: creditNoteId },
    select: { id: true, status: true, creditNo: true, readError: true },
  });
  if (!note) return { outcome: "not_found" };
  if (!LIVE.includes(note.status)) return { outcome: "closed" };
  if (note.readError || !note.creditNo) {
    return { outcome: "invalid", error: "This credit note was not read properly — read it again, or reject it." };
  }

  // Checked again now, so the dispatcher signs against what is true at this
  // moment — and the issues printed on the sign-off page are these.
  const evaluation = await reassessCreditNote(tenantId, creditNoteId);
  if (!evaluation) return { outcome: "closed" };
  const check = validateSignOff(input, evaluation.issues.length);
  if (!check.ok) return { outcome: "invalid", error: check.error, issues: evaluation.issues };

  const allocated = evaluation.matches.flatMap((m) => m.allocations.map((a) => ({ lineNo: m.lineNo, ...a })));
  const collectionLines = allocated.length
    ? await db.collectionLine.findMany({
        where: { id: { in: allocated.map((a) => a.collectionLineId) } },
        select: { id: true, collectionId: true, itemCode: true },
      })
    : [];
  const lineOf = new Map(collectionLines.map((l) => [l.id, l]));

  const signedAt = new Date();
  const signed = await db.$transaction(async (tx) => {
    const res = await tx.creditNote.updateMany({
      where: { id: creditNoteId, status: { in: LIVE } },
      data: {
        status: "SIGNED",
        signedByName: check.signedByName,
        signedByLogin: by.name,
        signedByUserId: by.userId,
        signedAt,
        signature: String(input.signatureImage),
        acknowledgedIssues: evaluation.issues as unknown as Prisma.InputJsonValue,
        acknowledgement: check.acknowledgement,
        issues: evaluation.issues as unknown as Prisma.InputJsonValue,
      },
    });
    if (res.count === 0) return false; // signed or rejected by someone else just now
    const rows = allocated
      .filter((a) => lineOf.has(a.collectionLineId))
      .map((a) => ({
        creditNoteId,
        lineNo: a.lineNo,
        collectionId: lineOf.get(a.collectionLineId)!.collectionId,
        collectionLineId: a.collectionLineId,
        collectionNo: a.collectionNo,
        itemCode: lineOf.get(a.collectionLineId)!.itemCode,
        qty: a.qty,
      }));
    if (rows.length > 0) await tx.creditNoteAllocation.createMany({ data: rows });
    return true;
  });
  if (!signed) return { outcome: "closed" };

  await logAudit({
    action: "SIGN",
    entity: "credit_note",
    entityId: creditNoteId,
    userName: by.name,
    details: JSON.stringify({
      event: "credit_note_signed",
      creditNo: note.creditNo,
      signedByName: check.signedByName,
      acknowledged: evaluation.issues.map((i) => i.code),
    }),
    tenantId,
  });

  const filing = await fileSignedCreditNote(tenantId, creditNoteId);
  return { outcome: "signed", filed: filing.done, filingError: filing.error };
}

/**
 * Do whatever filing is left for a signed note: the signed copy, removing the
 * original, the reference page on each collection receipt. Safe to run again.
 */
export async function fileSignedCreditNote(
  tenantId: string,
  creditNoteId: string
): Promise<{ done: boolean; error: string | null }> {
  const db = scopedPrisma(tenantId);
  const note = await db.creditNote.findFirst({
    where: { id: creditNoteId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      allocations: true,
      collections: {
        where: { source: { in: ["AUTO", "MANUAL"] } },
        include: { collection: { select: { id: true, collectionNo: true, status: true, collectedAt: true, signedFilePath: true } } },
      },
    },
  });
  if (!note || note.status !== "SIGNED" || !note.signedAt || !note.creditNo) {
    return { done: false, error: "Not a signed credit note" };
  }
  const errors: string[] = [];
  const say = (what: string, err: unknown) => errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d));

  // 1. The signed copy.
  let signedFileId = note.signedFileId;
  let includesSource = note.signedIncludesSource;
  if (!signedFileId) {
    if (!note.signature) {
      errors.push("The signature is no longer held, so the signed copy cannot be built");
    } else {
      try {
        const source = await downloadFileById(tenantId, note.sourceItemId);
        const { pdf, includesSource: included } = await buildSignedCreditNotePdf(
          source,
          {
            creditNo: note.creditNo,
            creditDate: note.creditDate,
            invoiceNo: note.invoiceNo,
            customerName: note.deliverToName ?? note.billToName,
            accountNo: note.accountNo,
            subtotal: num(note.subtotal),
            vatAmount: num(note.vatAmount),
            total: num(note.total),
            lines: note.lines.map((l) => ({
              lineNo: l.lineNo,
              productCode: l.productCode,
              description: l.description,
              qty: Number(l.qty),
              allocations: note.allocations
                .filter((a) => a.lineNo === l.lineNo)
                .map((a) => ({ collectionNo: a.collectionNo, qty: Number(a.qty) })),
            })),
            collections: note.collections.map((l) => ({
              collectionNo: l.collection.collectionNo,
              status: l.collection.status,
              collectedAt: l.collection.collectedAt,
            })),
            acknowledged: ((note.acknowledgedIssues as unknown as CreditIssue[] | null) ?? []).map((i) => ({ message: i.message })),
            acknowledgement: note.acknowledgement,
            signedByName: note.signedByName ?? "",
            signedByLogin: note.signedByLogin ?? "",
            signedAt: note.signedAt,
          },
          Uint8Array.from(Buffer.from(note.signature.replace(/^data:image\/png;base64,/, ""), "base64"))
        );
        const filename = signedCreditFilename(
          note.creditNo,
          note.invoiceNo,
          note.collections.map((l) => l.collection.collectionNo)
        );
        const item = await uploadSignedCreditNote(tenantId, filename, pdf);
        signedFileId = item.id;
        includesSource = included;
        // The PDF is the record now; the signature PNG goes.
        await db.creditNote.update({
          where: { id: note.id },
          data: { signedFileId: item.id, signedFilename: filename, filedAt: new Date(), signedIncludesSource: included, signature: null },
        });
      } catch (err) {
        say("Filing the signed copy in Signed/", err);
      }
    }
  }

  // 2. The unsigned original — only once the signed copy holds its pages.
  if (signedFileId && !note.originalRemoved && ["Originals", "root"].includes(note.sourceFolder)) {
    if (!includesSource) {
      errors.push("The original could not be read into the signed copy, so it was left in Originals/");
    } else {
      try {
        await deleteFileById(tenantId, note.sourceItemId);
        await db.creditNote.update({ where: { id: note.id }, data: { originalRemoved: true, sourceFolder: "Signed" } });
      } catch (err) {
        say("Removing the original from Originals/", err);
      }
    }
  }

  // 3. The reference page on each collection's signed receipt.
  for (const link of note.collections) {
    if (link.receiptStampedAt || !link.collection.signedFilePath) continue;
    try {
      const receipt = await readSignedCollectionDocument(tenantId, link.collection.signedFilePath);
      if (!receipt) throw new Error(`${link.collection.signedFilePath} was not found in Collections/Signed`);
      const credited = note.allocations.filter((a) => a.collectionId === link.collection.id);
      const stamped = await appendCreditReference(receipt, {
        creditNo: note.creditNo,
        creditDate: note.creditDate,
        invoiceNo: note.invoiceNo,
        total: num(note.total),
        lines: credited.map((a) => {
          const line = note.lines.find((l) => l.lineNo === a.lineNo);
          return { productCode: a.itemCode ?? line?.productCode ?? null, description: line?.description ?? "", qty: Number(a.qty) };
        }),
        signedByName: note.signedByName ?? "",
        signedAt: note.signedAt,
      });
      await saveSignedCollection(tenantId, link.collection.signedFilePath, stamped);
      await db.creditNoteCollection.update({ where: { id: link.id }, data: { receiptStampedAt: new Date() } });
    } catch (err) {
      say(`Adding the credit reference to collection ${link.collection.collectionNo}'s receipt`, err);
    }
  }

  const error = errors.length ? errors.join(" · ") : null;
  await db.creditNote.update({ where: { id: note.id }, data: { filingError: error } });
  return { done: !error, error };
}

export type RejectResult = { outcome: "rejected" } | { outcome: "not_found" | "closed" } | { outcome: "invalid"; error: string };

/** The office will not sign this note: out of the queue, with a reason, into Rejected/. */
export async function rejectCreditNote(
  tenantId: string,
  creditNoteId: string,
  reason: unknown,
  by: string
): Promise<RejectResult> {
  const text = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (text.length < 3) return { outcome: "invalid", error: "Say why the credit note is rejected." };
  if (text.length > 600) return { outcome: "invalid", error: "Keep the reason under 600 characters." };

  const db = scopedPrisma(tenantId);
  const note = await db.creditNote.findFirst({
    where: { id: creditNoteId },
    select: { id: true, status: true, creditNo: true, sourceItemId: true, sourceFilename: true, sourceFolder: true, sourceModifiedAt: true },
  });
  if (!note) return { outcome: "not_found" };

  const res = await db.creditNote.updateMany({
    where: { id: creditNoteId, status: { in: LIVE } },
    // The claim is released: a corrected note re-issued under the same number
    // can then be taken in.
    data: { status: "REJECTED", creditNoClaim: null, rejectReason: text, rejectedBy: by, rejectedAt: new Date() },
  });
  if (res.count === 0) return { outcome: "closed" };

  if (note.sourceFolder === "Originals" || note.sourceFolder === "root") {
    await fileAway(
      tenantId,
      note.id,
      {
        itemId: note.sourceItemId,
        filename: note.sourceFilename,
        subfolder: note.sourceFolder,
        lastModified: note.sourceModifiedAt?.toISOString() ?? null,
      },
      "rejected"
    );
  }

  await logAudit({
    action: "STATUS_CHANGE",
    entity: "credit_note",
    entityId: creditNoteId,
    userName: by,
    details: JSON.stringify({ event: "credit_note_rejected", reason: text, creditNo: note.creditNo }),
    tenantId,
  });
  return { outcome: "rejected" };
}

/** Signed notes whose filing did not finish, tried again. A few per look. */
export async function retryPendingFilings(tenantId: string, limit = 5): Promise<number> {
  const db = scopedPrisma(tenantId);
  const pending = await db.creditNote.findMany({
    where: { status: "SIGNED", filingError: { not: null } },
    select: { id: true },
    orderBy: { signedAt: "asc" },
    take: limit,
  });
  let done = 0;
  for (const p of pending) {
    if ((await fileSignedCreditNote(tenantId, p.id)).done) done++;
  }
  return done;
}

/**
 * Everything the Credits page sets off when it is open: a look at the folder,
 * then any filing left unfinished. After the response; never inline.
 */
export function scheduleCreditsWork(tenantId: string): void {
  try {
    after(async () => {
      try {
        // Retried only by whoever won the folder check's claim, so a page
        // open on several screens does not retry once per screen.
        const look = await syncCreditsFolder(tenantId);
        if (look.outcome === "checked") await retryPendingFilings(tenantId);
      } catch (err) {
        console.error(`Credits work failed for scope ${tenantId}:`, err);
      }
    });
  } catch {
    // No request scope.
  }
}

