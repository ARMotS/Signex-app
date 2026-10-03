/**
 * Collection receipt email: the customer's copy of a signed collection, with
 * the signed collection sheet attached.
 *
 * The collection counterpart of lib/delivery-notify.ts, and deliberately the
 * same shape — read that file's header for the reasoning. In short:
 *
 *   - Sent AUTOMATICALLY once the outcome is recorded, deferred past the
 *     response so a driver on a phone is never held on SMTP.
 *   - Never throws. A collection is recorded whether or not a relay is
 *     reachable; every failure is written to the row instead.
 *   - Begins by CLAIMING the row with a conditional updateMany into SENDING, so
 *     the automatic send and an office Send pressed at the same moment cannot
 *     both mail the customer. The claim is a lease: one older than
 *     STALE_CLAIM_MS is re-claimable, or a crashed attempt would strand it.
 *
 * Only COLLECTED and PARTIAL are sent. Those are the outcomes where goods
 * changed hands and the customer signed; NOT_AVAILABLE and REFUSED have no
 * signature and nothing for the customer to keep a receipt of.
 *
 * `tenantId` first and required: the collection is resolved through the scoped
 * client, so another ADMIN's collection is simply not found and their customer
 * can never be emailed from here.
 */

import { after } from "next/server";
import type { CollectionStatus } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import { sendCollectionReceipt } from "./email";
import { readSignedCollectionDocument } from "./collections";
import type { NotifyOptions, NotifyResult } from "./delivery-notify";

/** Same lease as delivery confirmations — see lib/delivery-notify.ts. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/** Outcomes that carry a customer signature, and so a receipt worth sending. */
export const RECEIPT_STATUSES: CollectionStatus[] = ["COLLECTED", "PARTIAL"];

const SUBTYPE_LABEL: Record<string, string> = {
  COMPANY_PARCEL: "Company parcel",
  EQUIPMENT_OR_CRATES: "Equipment / crates",
  DOCUMENTS: "Documents",
  SPECIAL_REQUEST: "Special request",
};

/**
 * Send (or re-send) the receipt for one recorded collection.
 *
 * Reuses delivery-notify's outcome vocabulary; "not_signed" here means the
 * collection has no signed outcome (still PENDING, or NOT_AVAILABLE/REFUSED),
 * or is not in this scope.
 */
export async function sendCollectionReceiptEmail(
  tenantId: string,
  collectionId: string,
  opts: Pick<NotifyOptions, "force"> = {}
): Promise<NotifyResult> {
  const db = scopedPrisma(tenantId);

  try {
    const collection = await db.collection.findFirst({
      where: { id: collectionId },
      include: {
        stop: { include: { contact: true } },
        driver: { select: { name: true } },
      },
    });

    if (!collection || !RECEIPT_STATUSES.includes(collection.status)) {
      return { outcome: "not_signed", sent: false };
    }

    // A stop deployed without its contact linked — the customer was added to
    // Contacts afterwards, or the sheet came in by a path that did not link —
    // is resolved here by exact company name, the same rule invoice signing
    // uses. Exact, not fuzzy: the receipt carries signed paperwork, and a near
    // miss would mail it to the wrong company.
    let contact = collection.stop.contact;
    if (!contact) {
      const name = collection.stop.customerName.trim();
      contact = name
        ? await db.contact.findFirst({
            where: { deletedAt: null, companyName: { equals: name, mode: "insensitive" } },
          })
        : null;
      if (contact) {
        await db.stop.updateMany({
          where: { id: collection.stop.id, contactId: null },
          data: { contactId: contact.id },
        });
      }
    }

    if (!contact?.email) {
      await db.collection.updateMany({
        where: { id: collectionId },
        data: { emailStatus: "NO_EMAIL", emailError: null },
      });
      return { outcome: "no_email", sent: false };
    }

    if (collection.emailStatus === "SENT" && !opts.force) {
      return { outcome: "already_sent", sent: true, recipient: contact.email };
    }

    // ── Claim the attempt ────────────────────────────────────────────────
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
    const claimable: Record<string, unknown>[] = [
      { emailStatus: { in: ["NOT_SENT", "FAILED", "NO_EMAIL"] } },
      {
        emailStatus: "SENDING",
        OR: [
          { emailLastAttemptAt: null },
          { emailLastAttemptAt: { lt: staleBefore } },
        ],
      },
    ];
    if (opts.force) claimable.push({ emailStatus: "SENT" });

    const claim = await db.collection.updateMany({
      where: { id: collectionId, status: { in: RECEIPT_STATUSES }, OR: claimable },
      data: {
        emailStatus: "SENDING",
        emailLastAttemptAt: new Date(),
        emailAttempts: { increment: 1 },
      },
    });

    if (claim.count === 0) {
      return { outcome: "in_flight", sent: false, recipient: contact.email };
    }

    // ── Build and send ───────────────────────────────────────────────────
    // Best-effort attachment, as for invoices: a receipt without the PDF is far
    // better than no receipt. A missing document is already on the office's
    // list via signedFilePath being null.
    let pdfAttachment: { filename: string; content: Buffer } | undefined;
    if (collection.signedFilePath) {
      try {
        const content = await readSignedCollectionDocument(tenantId, collection.signedFilePath);
        if (content) pdfAttachment = { filename: collection.signedFilePath, content };
      } catch (err) {
        console.error("[collection-notify] Could not read signed PDF for attachment:", err);
      }
    }

    const typeLabel =
      collection.type === "CREDIT_RETURN"
        ? "Credit return"
        : `Uplift${
            collection.upliftSubtype
              ? ` — ${SUBTYPE_LABEL[collection.upliftSubtype] ?? collection.upliftSubtype}`
              : ""
          }`;

    const quantityLine =
      collection.collectedQty != null
        ? collection.expectedQty != null
          ? `${collection.collectedQty} of ${collection.expectedQty}`
          : String(collection.collectedQty)
        : undefined;

    const result = await sendCollectionReceipt({
      customerEmail: contact.email,
      customerName: contact.companyName,
      contactPerson: contact.contactPerson ?? undefined,
      collectionNo: collection.collectionNo,
      typeLabel,
      outcomeLabel: collection.status === "PARTIAL" ? "Partly collected" : "Collected in full",
      quantityLine,
      signedByName: collection.signedByName ?? undefined,
      driverName: collection.driver?.name ?? "Unknown",
      collectedAt: collection.collectedAt ?? new Date(),
      companyName: process.env.COMPANY_NAME ?? "Signex",
      pdfAttachment,
    });

    if (result.success) {
      await db.collection.updateMany({
        where: { id: collectionId },
        data: { emailStatus: "SENT", emailSentAt: new Date(), emailError: null },
      });
      return { outcome: "sent", sent: true, recipient: contact.email };
    }

    const error = result.error ?? "The mail server rejected the message";
    await db.collection.updateMany({
      where: { id: collectionId },
      data: { emailStatus: "FAILED", emailError: error },
    });
    return { outcome: "failed", sent: false, recipient: contact.email, error };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`[collection-notify] Collection ${collectionId}:`, err);
    try {
      await db.collection.updateMany({
        where: { id: collectionId, emailStatus: "SENDING" },
        data: { emailStatus: "FAILED", emailError: error },
      });
    } catch {
      // The database is what just failed; the lease keeps it retryable.
    }
    return { outcome: "failed", sent: false, error };
  }
}

async function autoSendCollectionReceipt(tenantId: string, collectionId: string): Promise<void> {
  const result = await sendCollectionReceiptEmail(tenantId, collectionId);
  if (result.outcome === "failed") {
    console.warn(
      `[collection-notify] Automatic receipt for collection ${collectionId} failed (${result.error})`
    );
  }
}

/**
 * Schedule the automatic receipt for after the response is sent.
 *
 * Guarded exactly as scheduleDeliveryConfirmation is: `after()` throws with no
 * request scope, and an unguarded throw here would escape a handler that has
 * already recorded the collection — a 500 for a collection that is in fact
 * signed. Without a request scope the send runs inline instead.
 */
export async function scheduleCollectionReceipt(
  tenantId: string,
  collectionId: string
): Promise<void> {
  try {
    after(() => autoSendCollectionReceipt(tenantId, collectionId));
  } catch {
    await autoSendCollectionReceipt(tenantId, collectionId);
  }
}
