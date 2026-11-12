/**
 * The office's decision on a credit return that came back: approved for
 * credit, or rejected (not creditable). See creditReviewRequired in
 * lib/collection-confirm.ts for which collections need one.
 *
 *   • Accounts makes the credit note only once the collection is approved,
 *     and never for a rejected one — so a note waits on this decision
 *     (COLLECTION_NOT_APPROVED blocks signing; see lib/credit-note.ts).
 *   • It does NOT hold the trip open (client decision): the driver's work is
 *     done when the goods are back. The decision is made on the Collections
 *     tab, on the Collection row — which outlives its trip — so it can be made
 *     before or after the trip closes.
 *   • A REJECTED collection stays on record — the signed receipt is the
 *     customer's proof of what was handed over — but no credit note is ever
 *     matched to it, and one that arrives for it is flagged on the Credits page.
 *   • The handling charge (the sheet's Charged / NO Charge / 20% to Customer
 *     boxes) is optional and decided with it. Left out of a request it stays
 *     as it was, so a tab on the previous bundle cannot wipe it; null clears it.
 *   • The decision can be changed — a dispatcher who approves by mistake
 *     rejects again — and is recorded each time. Readers of the archive take
 *     it from the row, not the frozen snapshot.
 *   • Every live credit note the decision touches is checked again before the
 *     answer goes back, so the Credits page is already right when the office
 *     gets there, and the office is told what became of those notes.
 */

import { scopedPrisma } from "./db-scoped";
import { CREDIT_CHARGES, creditReviewRequired, type CreditCharge } from "./collection-confirm";
import { collectionMatchKeys, sameCollectionNumber } from "./collections";
import { reassessCreditNote } from "./credit-intake";
import { signBlocker } from "./credit-note";
import { logAudit } from "./audit";

export type ReviewDecision = "APPROVE" | "REJECT";

/** A live credit note the decision reached, and whether it can now be signed. */
export interface CreditNoteEffect {
  id: string;
  creditNo: string | null;
  signable: boolean;
}

export type ReviewResult =
  | { outcome: "decided"; creditReview: "APPROVED" | "REJECTED"; creditNotes: CreditNoteEffect[] }
  | { outcome: "not_found" }
  | { outcome: "not_reviewable" | "conflict" | "invalid"; error: string };

export async function reviewCreditCollection(
  tenantId: string,
  collectionId: string,
  decision: unknown,
  reason: unknown,
  by: string,
  charge?: unknown
): Promise<ReviewResult> {
  if (decision !== "APPROVE" && decision !== "REJECT") {
    return { outcome: "invalid", error: "decision must be APPROVE or REJECT" };
  }
  const text = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (decision === "REJECT" && text.length < 3) {
    return { outcome: "invalid", error: "Say why the collection is rejected for credit." };
  }
  if (text.length > 600) return { outcome: "invalid", error: "Keep the reason under 600 characters." };
  if (charge !== undefined && charge !== null && !CREDIT_CHARGES.includes(charge as CreditCharge)) {
    return { outcome: "invalid", error: "That handling charge is not recognised." };
  }

  const db = scopedPrisma(tenantId);
  const collection = await db.collection.findFirst({
    where: { id: collectionId },
    select: {
      id: true,
      collectionNo: true,
      type: true,
      originalInvoiceNo: true,
      status: true,
      creditReview: true,
      creditCharge: true,
      invoiceId: true,
      invoiceNoNormalized: true,
    },
  });
  if (!collection) return { outcome: "not_found" };
  if (!creditReviewRequired(collection)) {
    return {
      outcome: "not_reviewable",
      error: "Only a credit return against an invoice that came back (collected or partly collected) is approved or rejected.",
    };
  }
  const creditReview = decision === "APPROVE" ? "APPROVED" : "REJECTED";
  // Conditional on the row still being what was checked: a collection the
  // office re-recorded in the meantime is left alone.
  const res = await db.collection.updateMany({
    where: { id: collectionId, status: { in: ["COLLECTED", "PARTIAL"] } },
    data: {
      creditReview,
      creditReviewReason: text || null,
      creditReviewedBy: by,
      creditReviewedAt: new Date(),
      ...(charge !== undefined && { creditCharge: charge as CreditCharge | null }),
    },
  });
  if (res.count === 0) {
    return { outcome: "conflict", error: "This collection changed while you were deciding — refresh and try again." };
  }

  await logAudit({
    action: "STATUS_CHANGE",
    entity: "collection",
    entityId: collectionId,
    userName: by,
    details: JSON.stringify({
      event: decision === "APPROVE" ? "credit_collection_approved" : "credit_collection_rejected",
      collectionNo: collection.collectionNo,
      previous: collection.creditReview,
      reason: text || null,
      charge: charge === undefined ? collection.creditCharge : charge,
      previousCharge: collection.creditCharge,
    }),
    tenantId,
  });

  // Checked again now, not on the next look at the folder: a rejected
  // collection must stop counting at once. By invoice and by the number a note
  // names as well as by link, because rejecting a collection drops its AUTO
  // links — approving it again has to find those notes without them.
  const [exactNo, , unpaddedNo] = collectionMatchKeys(collection.collectionNo);
  const numberKey = unpaddedNo ?? exactNo;
  const affected = await db.creditNote.findMany({
    where: {
      status: { in: ["RECEIVED", "NEEDS_REVIEW"] },
      OR: [
        { collections: { some: { collectionId } } },
        ...(collection.invoiceNoNormalized ? [{ invoiceNoNormalized: collection.invoiceNoNormalized }] : []),
        ...(collection.invoiceId ? [{ invoiceId: collection.invoiceId }] : []),
        ...(numberKey ? [{ collectionRef: { endsWith: numberKey, mode: "insensitive" as const } }] : []),
      ],
    },
    select: {
      id: true,
      creditNo: true,
      readError: true,
      invoiceId: true,
      invoiceNoNormalized: true,
      collectionRef: true,
      collections: { where: { collectionId }, select: { id: true } },
    },
    // One at a time, oldest first: a later note yields to what earlier ones
    // already pay for, so each must see the links the one before it wrote.
    orderBy: { createdAt: "asc" },
  });

  // endsWith only narrows the read: CRC-23328 ends in 8, and is not collection 8.
  const reached = affected.filter(
    (n) =>
      n.collections.length > 0 ||
      (!!n.invoiceNoNormalized && n.invoiceNoNormalized === collection.invoiceNoNormalized) ||
      (!!n.invoiceId && n.invoiceId === collection.invoiceId) ||
      (!!n.collectionRef && sameCollectionNumber(n.collectionRef, collection.collectionNo))
  );

  const creditNotes: CreditNoteEffect[] = [];
  for (const note of reached) {
    const evaluation = await reassessCreditNote(tenantId, note.id);
    if (!evaluation) continue;
    creditNotes.push({
      id: note.id,
      creditNo: note.creditNo,
      signable: !!note.creditNo && !note.readError && !signBlocker(evaluation.issues),
    });
  }

  return { outcome: "decided", creditReview, creditNotes };
}
