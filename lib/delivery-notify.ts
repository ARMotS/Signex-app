/**
 * Delivery-confirmation email: the one place a customer gets told their
 * delivery is signed for.
 *
 * The confirmation is sent AUTOMATICALLY the moment the customer signs — the
 * driver does not have to remember, and does not have to still be standing at
 * the door when it goes out. Sending is best-effort by design: a delivery is
 * signed for whether or not an SMTP relay is reachable, so nothing in here can
 * fail a signature. Every failure is instead recorded on the stop, where it
 * becomes an item in the dispatcher's queue on the dashboard.
 *
 * ── Why the claim ─────────────────────────────────────────────────────────
 * Two senders race by construction: the automatic send fires on signature while
 * the dispatcher can press Send on the same stop from the dashboard. Mailing a
 * customer the same confirmation twice looks broken, so an attempt begins by
 * CLAIMING the stop with a conditional updateMany. Exactly one caller can move
 * a stop into SENDING; everyone else is told the work is already in flight.
 *
 * The claim is a lease, not a lock: a process killed mid-send would otherwise
 * strand the stop in SENDING forever and put it beyond the dispatcher's reach.
 * A SENDING claim older than STALE_CLAIM_MS is therefore re-claimable.
 *
 * Every function takes `tenantId` as its first, required argument — the stop is
 * resolved through the scoped client, so a stop id belonging to another ADMIN is
 * simply not found and their customer can never be emailed from here.
 */

import fs from "fs";
import path from "path";
import { after } from "next/server";
import { scopedPrisma } from "./db-scoped";
import { sendDeliveryConfirmation } from "./email";
import { getInvoiceFolderPath } from "./invoices";
import {
  getOneDriveInvoiceSource,
  downloadSignedInvoiceByName,
} from "./microsoft-graph";

/**
 * How long a SENDING claim is honoured before another caller may take it over.
 * Long enough to cover a slow PDF download plus an SMTP handshake, short enough
 * that a crashed attempt does not sit in the dispatcher's queue looking busy.
 */
const STALE_CLAIM_MS = 2 * 60 * 1000;

export type NotifyOutcome =
  /** Delivered to the relay. */
  | "sent"
  /** Attempted and rejected — emailError holds why. */
  | "failed"
  /** The contact has no address; a human has to add one. */
  | "no_email"
  /** Already sent, and this call did not ask to send it again. */
  | "already_sent"
  /** Another caller is mid-attempt on this stop right now. */
  | "in_flight"
  /** The stop isn't signed yet, or isn't in this scope. */
  | "not_signed";

export interface NotifyResult {
  outcome: NotifyOutcome;
  /** True only for `sent` — the shape route handlers report as `success`. */
  sent: boolean;
  recipient?: string;
  error?: string;
}

export interface NotifyOptions {
  /**
   * Shown in the email as who delivered. Resolved from the stop's trip sheet
   * when omitted, which is what the automatic send relies on — it has no
   * driver-supplied name to trust.
   */
  driverName?: string;
  /**
   * Send again even though the stop is already SENT. This is a dispatcher
   * pressing Resend, never the automatic path. It does NOT override an in-flight
   * claim: a resend must not race the automatic send it is trying to replace.
   */
  force?: boolean;
}

/**
 * Send (or re-send) the delivery confirmation for one signed stop.
 *
 * Never throws — callers include the signature-save path, where an email
 * problem must not surface to a driver standing at a customer's door.
 */
export async function sendStopDeliveryConfirmation(
  tenantId: string,
  stopId: string,
  opts: NotifyOptions = {}
): Promise<NotifyResult> {
  const db = scopedPrisma(tenantId);

  try {
    const stop = await db.stop.findFirst({
      where: { id: stopId },
      include: {
        contact: true,
        tripSheet: { select: { driverId: true } },
      },
    });

    // Not found is indistinguishable from "in another scope" — deliberately.
    if (!stop || stop.status !== "SIGNED") {
      return { outcome: "not_signed", sent: false };
    }

    if (!stop.contact?.email) {
      // Not a failure to retry: no amount of resending invents an address. Mark
      // it so the dispatcher sees "needs an email address" rather than a stop
      // that looks like it is still waiting its turn.
      await db.stop.updateMany({
        where: { id: stopId },
        data: { emailStatus: "NO_EMAIL", emailError: null },
      });
      return { outcome: "no_email", sent: false };
    }

    if (stop.emailStatus === "SENT" && !opts.force) {
      return { outcome: "already_sent", sent: true, recipient: stop.contact.email };
    }

    // ── Claim the attempt ────────────────────────────────────────────────
    // Conditional update: whoever's UPDATE lands first is the one that sends.
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

    const claim = await db.stop.updateMany({
      where: { id: stopId, status: "SIGNED", OR: claimable },
      data: {
        emailStatus: "SENDING",
        emailLastAttemptAt: new Date(),
        emailAttempts: { increment: 1 },
      },
    });

    if (claim.count === 0) {
      // Someone else holds a fresh claim. Their result is the one that counts.
      return { outcome: "in_flight", sent: false, recipient: stop.contact.email };
    }

    // ── Build and send ───────────────────────────────────────────────────
    const driverName =
      opts.driverName ??
      (await resolveDriverName(tenantId, stop.tripSheet?.driverId));

    const pdfAttachment = await readSignedPdf(tenantId, stop.invoiceFile);

    const result = await sendDeliveryConfirmation({
      customerEmail: stop.contact.email,
      customerName: stop.contact.companyName,
      contactPerson: stop.contact.contactPerson ?? undefined,
      invoiceNumber: stop.invoiceNumber,
      driverName,
      deliveryAddress: stop.address,
      signedAt: stop.signedAt ?? new Date(),
      signedPDFUrl: "",
      companyName: process.env.COMPANY_NAME ?? "Signex",
      pdfAttachment,
    });

    if (result.success) {
      await db.stop.updateMany({
        where: { id: stopId },
        data: {
          emailStatus: "SENT",
          emailSentAt: new Date(),
          emailError: null,
        },
      });
      return { outcome: "sent", sent: true, recipient: stop.contact.email };
    }

    const error = "The mail server rejected the message";
    await db.stop.updateMany({
      where: { id: stopId },
      data: { emailStatus: "FAILED", emailError: error },
    });
    return { outcome: "failed", sent: false, recipient: stop.contact.email, error };
  } catch (err) {
    // Anything unexpected — a database blip, a Graph outage while fetching the
    // attachment — still has to leave the stop retryable rather than stuck in
    // SENDING with nobody coming back for it.
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`[delivery-notify] Stop ${stopId}:`, err);
    try {
      await db.stop.updateMany({
        where: { id: stopId, emailStatus: "SENDING" },
        data: { emailStatus: "FAILED", emailError: error },
      });
    } catch {
      // The database is the thing that just failed. Nothing further to do —
      // the stale-claim lease means the dispatcher can still retry.
    }
    return { outcome: "failed", sent: false, error };
  }
}

/**
 * Fire the automatic confirmation without making the caller wait or handle it.
 *
 * Used from the signature-save routes inside `after()`, so the driver's device
 * gets its response as soon as the signature is durable and the mail goes out
 * behind it.
 */
export async function autoSendDeliveryConfirmation(
  tenantId: string,
  stopId: string
): Promise<void> {
  const result = await sendStopDeliveryConfirmation(tenantId, stopId);
  if (result.outcome === "failed") {
    console.warn(
      `[delivery-notify] Automatic confirmation for stop ${stopId} failed (${result.error}); queued for the dispatcher`
    );
  }
}

/**
 * Schedule the automatic confirmation for after the response is sent.
 *
 * This is what the signature-save routes call, and it exists rather than a bare
 * `after()` because `after()` THROWS when there is no request scope to defer
 * into. Left unguarded, that exception propagates out of a handler which has
 * already written the signature — the driver gets a 500 for a delivery that is
 * in fact signed and saved, which is precisely the outcome the whole "nothing
 * about email can fail a signature" rule exists to prevent.
 *
 * Without a request scope the send simply runs inline: slower for the caller,
 * but the customer still gets their confirmation and the result is
 * deterministic, which is also what makes the behaviour testable.
 *
 * Safe to await — in a real request `after()` returns immediately.
 */
export async function scheduleDeliveryConfirmation(
  tenantId: string,
  stopId: string
): Promise<void> {
  try {
    after(() => autoSendDeliveryConfirmation(tenantId, stopId));
  } catch {
    await autoSendDeliveryConfirmation(tenantId, stopId);
  }
}

/** The driver shown on the email. "Unknown" beats failing to send. */
async function resolveDriverName(
  tenantId: string,
  driverId: string | undefined
): Promise<string> {
  if (!driverId) return "Unknown";
  const db = scopedPrisma(tenantId);
  const driver = await db.driver.findFirst({
    where: { id: driverId },
    select: { name: true },
  });
  return driver?.name ?? "Unknown";
}

/**
 * Read the signed PDF to attach, from this scope's OneDrive or its local
 * invoice folder. Best-effort: a confirmation without the attachment is far
 * better than no confirmation.
 */
async function readSignedPdf(
  tenantId: string,
  invoiceFile: string | null
): Promise<{ filename: string; content: Buffer } | undefined> {
  if (!invoiceFile) return undefined;

  try {
    const onedrive = await getOneDriveInvoiceSource(tenantId);
    if (onedrive) {
      // One addressed download rather than enumerating the signed folder.
      const content = await downloadSignedInvoiceByName(tenantId, invoiceFile);
      return content ? { filename: `signed-${invoiceFile}`, content } : undefined;
    }

    const folderPath = await getInvoiceFolderPath(tenantId);
    const signedPath = path.join(folderPath, "signed", invoiceFile);
    // invoiceFile is parsed out of a trip sheet, not typed by a caller, but the
    // containment check costs nothing and keeps "../" out of the join.
    const resolved = path.resolve(signedPath);
    if (!resolved.startsWith(path.resolve(folderPath))) return undefined;
    if (!fs.existsSync(resolved)) return undefined;

    return { filename: `signed-${invoiceFile}`, content: fs.readFileSync(resolved) };
  } catch (err) {
    console.error("[delivery-notify] Could not read signed PDF for attachment:", err);
    return undefined;
  }
}
