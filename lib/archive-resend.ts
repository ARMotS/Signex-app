/**
 * Resending a delivery confirmation after its trip sheet has been completed.
 *
 * Completing a trip sheet deletes its stops, so the live send path
 * (lib/delivery-notify.ts) has nothing left to address. This one works from the
 * CompletedTripSheet snapshot instead, and resolves the recipient at send time
 * by exact company name — the way collection receipts do — so a dispatcher who
 * has since fixed the customer's email address can resend to the right one.
 *
 * ── The budget ────────────────────────────────────────────────────────────
 * At most MAX_ARCHIVE_RESENDS per delivery. Each attempt first writes an
 * ArchivedEmailResend row whose `attempt` is unique per archived stop and
 * CHECK-constrained to 1..3 in the database, so the limit holds even when two
 * dispatchers press Resend at the same moment. A failed send deletes its row:
 * a dead relay must not use up a customer's resends.
 *
 * Never throws — every outcome is a result the route reports.
 */

import { Prisma } from "@prisma/client";
import { scopedPrisma } from "./db-scoped";
import { sendDeliveryConfirmation } from "./email";
import { readSignedPdf } from "./delivery-notify";
import { listInvoiceFiles } from "./invoices";
import { buildInvoiceLookup, matchInvoiceFile } from "./invoice-number";
import { readInvoiceNoPattern } from "./config";
import type { ArchivedStop } from "./trip-data";

/** Resends allowed per delivery. Mirrored by the CHECK in the migration. */
export const MAX_ARCHIVE_RESENDS = 3;

/** An in-flight attempt older than this is treated as crashed and cleared. */
const STALE_ATTEMPT_MS = 2 * 60 * 1000;

export type ArchiveResendOutcome =
  | "sent"
  | "failed"
  /** No such archived sheet or stop in this scope — or it was never signed. */
  | "not_found"
  | "no_email"
  | "limit_reached"
  | "in_flight";

export interface ArchiveResendResult {
  outcome: ArchiveResendOutcome;
  recipient?: string;
  error?: string;
  /** Resends that have gone out for this delivery, after this call. */
  used: number;
  /** False when the signed PDF could not be found to attach. */
  attached?: boolean;
}

export async function resendArchivedConfirmation(
  tenantId: string,
  completedTripSheetId: string,
  stopNumber: number,
  sentBy: string | null
): Promise<ArchiveResendResult> {
  const db = scopedPrisma(tenantId);
  let claimId: string | null = null;
  let used = 0;

  try {
    const sheet = await db.completedTripSheet.findFirst({
      where: { id: completedTripSheetId },
    });
    const stops = Array.isArray(sheet?.stops)
      ? (sheet.stops as unknown as ArchivedStop[])
      : [];
    const stop = stops.find((s) => s.stopNumber === stopNumber);
    // A collection-only stop has no invoice and so no delivery confirmation.
    if (!sheet || !stop || !stop.signedAt || !stop.invoiceNumber) {
      return { outcome: "not_found", used: 0 };
    }

    const key = { completedTripSheetId, stopNumber };

    // Clear a crashed attempt, so it cannot hold a slot forever.
    await db.archivedEmailResend.deleteMany({
      where: { ...key, sentAt: null, createdAt: { lt: new Date(Date.now() - STALE_ATTEMPT_MS) } },
    });

    const existing = await db.archivedEmailResend.findMany({
      where: key,
      select: { attempt: true, sentAt: true },
    });
    used = existing.filter((r) => r.sentAt).length;
    if (existing.some((r) => !r.sentAt)) return { outcome: "in_flight", used };
    if (existing.length >= MAX_ARCHIVE_RESENDS) return { outcome: "limit_reached", used };

    const contact = await db.contact.findFirst({
      where: {
        deletedAt: null,
        companyName: { equals: stop.customerName, mode: "insensitive" },
      },
    });
    if (!contact?.email) return { outcome: "no_email", used };

    // ── Claim the next slot ──────────────────────────────────────────────
    const nextAttempt = Math.max(0, ...existing.map((r) => r.attempt)) + 1;
    try {
      const claim = await db.archivedEmailResend.create({
        data: { ...key, attempt: nextAttempt, recipient: contact.email, sentBy },
      });
      claimId = claim.id;
    } catch (err) {
      // Someone else took this slot between our read and our write.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { outcome: "in_flight", used };
      }
      throw err;
    }

    // ── Send ─────────────────────────────────────────────────────────────
    const invoiceFile =
      stop.invoiceFile ?? (await findSignedInvoiceFile(tenantId, stop.invoiceNumber));
    const pdfAttachment = await readSignedPdf(tenantId, invoiceFile);

    const result = await sendDeliveryConfirmation({
      customerEmail: contact.email,
      customerName: contact.companyName,
      contactPerson: contact.contactPerson ?? undefined,
      invoiceNumber: stop.invoiceNumber,
      driverName: sheet.driverName,
      deliveryAddress: stop.address,
      signedByName: stop.signedByName ?? undefined,
      signedAt: new Date(stop.signedAt),
      signedPDFUrl: "",
      companyName: process.env.COMPANY_NAME ?? "Signex",
      pdfAttachment,
    });

    if (!result.success) {
      await db.archivedEmailResend.deleteMany({ where: { id: claimId } });
      claimId = null;
      return {
        outcome: "failed",
        recipient: contact.email,
        error: result.error ?? "The mail server rejected the message",
        used,
      };
    }

    await db.archivedEmailResend.updateMany({
      where: { id: claimId },
      data: { sentAt: new Date() },
    });
    claimId = null;
    return {
      outcome: "sent",
      recipient: contact.email,
      used: used + 1,
      attached: !!pdfAttachment,
    };
  } catch (err) {
    console.error(`[archive-resend] ${completedTripSheetId} stop ${stopNumber}:`, err);
    if (claimId) {
      await db.archivedEmailResend.deleteMany({ where: { id: claimId } }).catch(() => {});
    }
    return {
      outcome: "failed",
      error: err instanceof Error ? err.message : "Unknown error",
      used,
    };
  }
}

/**
 * The signed PDF for an invoice number, for snapshots taken before the
 * filename was frozen into them. Exact and base keys only — the same strictness
 * as the already-signed check, because a loose match here would attach some
 * other customer's invoice.
 */
async function findSignedInvoiceFile(
  tenantId: string,
  invoiceNumber: string
): Promise<string | null> {
  try {
    const [files, pattern] = await Promise.all([
      listInvoiceFiles(tenantId),
      readInvoiceNoPattern(tenantId),
    ]);
    const signed = files.filter((f) => f.isSigned);
    return matchInvoiceFile(buildInvoiceLookup(signed, 1, pattern), invoiceNumber, 1, pattern) ?? null;
  } catch {
    return null;
  }
}
