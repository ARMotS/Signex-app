/**
 * The office's decision on a credit return that came back: approved for
 * credit, or rejected (not creditable). See creditReviewRequired in
 * lib/collection-confirm.ts for which collections need one.
 *
 *   • Until every such collection on a trip is decided, the trip cannot be
 *     completed (lib/trip-data.ts completeTripSheet).
 *   • A REJECTED collection stays on record — the signed receipt is the
 *     customer's proof of what was handed over — but no credit note is ever
 *     matched to it, and one that arrives for it is flagged on the Credits page.
 *   • Decided only while the trip is live. The completed archive freezes the
 *     decision with the rest of the day, so it can never drift from it.
 *   • The decision can be changed while the trip is live — a dispatcher who
 *     approves by mistake rejects again — and is recorded each time.
 */

import { scopedPrisma } from "./db-scoped";
import { creditReviewRequired } from "./collection-confirm";
import { reassessCreditNote } from "./credit-intake";
import { logAudit } from "./audit";

export type ReviewDecision = "APPROVE" | "REJECT";

export type ReviewResult =
  | { outcome: "decided"; creditReview: "APPROVED" | "REJECTED" }
  | { outcome: "not_found" }
  | { outcome: "not_reviewable" | "archived" | "invalid"; error: string };

export async function reviewCreditCollection(
  tenantId: string,
  collectionId: string,
  decision: unknown,
  reason: unknown,
  by: string
): Promise<ReviewResult> {
  if (decision !== "APPROVE" && decision !== "REJECT") {
    return { outcome: "invalid", error: "decision must be APPROVE or REJECT" };
  }
  const text = typeof reason === "string" ? reason.replace(/\s+/g, " ").trim() : "";
  if (decision === "REJECT" && text.length < 3) {
    return { outcome: "invalid", error: "Say why the collection is rejected for credit." };
  }
  if (text.length > 600) return { outcome: "invalid", error: "Keep the reason under 600 characters." };

  const db = scopedPrisma(tenantId);
  const collection = await db.collection.findFirst({
    where: { id: collectionId },
    select: {
      id: true,
      collectionNo: true,
      type: true,
      originalInvoiceNo: true,
      status: true,
      tripSheetId: true,
      creditReview: true,
    },
  });
  if (!collection) return { outcome: "not_found" };
  if (!creditReviewRequired(collection)) {
    return {
      outcome: "not_reviewable",
      error: "Only a credit return against an invoice that came back (collected or partly collected) is approved or rejected.",
    };
  }
  if (!collection.tripSheetId) {
    return { outcome: "archived", error: "This trip has been completed; its decisions are part of the archive." };
  }

  const creditReview = decision === "APPROVE" ? "APPROVED" : "REJECTED";
  // Conditional on the row still being what was checked: a collection the
  // office re-recorded (or a trip completed) in the meantime is left alone.
  const res = await db.collection.updateMany({
    where: { id: collectionId, status: { in: ["COLLECTED", "PARTIAL"] }, tripSheetId: { not: null } },
    data: {
      creditReview,
      creditReviewReason: text || null,
      creditReviewedBy: by,
      creditReviewedAt: new Date(),
    },
  });
  if (res.count === 0) {
    return { outcome: "archived", error: "This collection changed while you were deciding — refresh and try again." };
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
    }),
    tenantId,
  });

  // Credit notes already linked to it are checked again now, not on the next
  // look at the folder: a rejected collection must stop counting at once.
  const links = await db.creditNoteCollection.findMany({
    where: { collectionId },
    select: { creditNoteId: true },
  });
  for (const l of links) await reassessCreditNote(tenantId, l.creditNoteId);

  return { outcome: "decided", creditReview };
}
