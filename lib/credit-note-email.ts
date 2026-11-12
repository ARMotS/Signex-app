/**
 * credit-note-email.ts
 * The customer's copy of a signed credit note: sent when the dispatcher
 * signs it (lib/credit-signoff.ts), with the signed copy from Signed/
 * attached. The office can Send / Resend from the note's panel.
 *
 * Like every other customer email, nothing here throws and nothing here can
 * undo a signature: the note is signed and filed before the email is tried,
 * and a failure is recorded on the note (emailStatus / emailError) for the
 * office to resend. Sending CLAIMS the note first with the same lease as
 * Stop.emailStatus, so a double click or two open panels never double-mail.
 *
 * ── Who it goes to ────────────────────────────────────────────────────────
 * Resolved at send time, so an address added later is the one used. The
 * customer's name is taken, strongest first, from the invoice the note
 * credits (the trip sheet's CUSTOMER, which is what contacts are named
 * after), the collections it pays for, then the names printed on the note
 * and the invoice PDF — "Deliver to" before "Invoice to", because on a cash
 * sale "Invoice to" is the cash account. Each is matched to a contact by
 * exact company name (companyKey: case and punctuation ignored, never fuzzy —
 * an email goes to it). The first name with a contact that has an address wins.
 */

import { scopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import { sendCreditNoteSigned } from "./email";
import { downloadFileById } from "./microsoft-graph";
import { readCustomerFacingCompany } from "./config";
import { companyKey } from "./courier-sheet";
import { formatStampTime } from "./courier-stamp-text";

const STALE_CLAIM_MS = 2 * 60 * 1000;
/** Mail relays refuse large messages; a copy past this is not attached. */
const MAX_ATTACHMENT_BYTES = 15_000_000;

export type CreditEmailOutcome =
  | "sent"
  | "failed"
  | "no_email"
  | "already_sent"
  | "in_flight"
  /** Not signed, or its signed copy is not filed yet. */
  | "not_ready"
  | "not_found";

export interface CreditEmailResult {
  outcome: CreditEmailOutcome;
  recipient?: string;
  error?: string;
}

// ─── Pure parts ──────────────────────────────────────────────────────────

/**
 * The customer names to look a contact up by, strongest first, each once
 * (by companyKey). Blank names are dropped.
 */
export function recipientNames(sources: {
  invoiceCustomer?: string | null;
  collectionCustomers?: (string | null | undefined)[];
  noteDeliverTo?: string | null;
  invoiceDeliverTo?: string | null;
  noteBillTo?: string | null;
  invoiceBillTo?: string | null;
}): string[] {
  const ordered = [
    sources.invoiceCustomer,
    ...(sources.collectionCustomers ?? []),
    sources.noteDeliverTo,
    sources.invoiceDeliverTo,
    sources.noteBillTo,
    sources.invoiceBillTo,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ordered) {
    const name = String(raw ?? "").trim();
    const key = companyKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface ContactCandidate {
  id: string;
  companyName: string;
  email: string | null;
  contactPerson: string | null;
}

/**
 * The contact the email goes to: for each name in order, a contact with
 * exactly that company name and an address. Null when none has one.
 */
export function pickRecipient(names: string[], contacts: ContactCandidate[]): (ContactCandidate & { email: string }) | null {
  for (const name of names) {
    const key = companyKey(name);
    const hit = contacts.find((c) => companyKey(c.companyName) === key && c.email?.trim());
    if (hit) return { ...hit, email: hit.email!.trim() };
  }
  return null;
}

/** "12 Nov 2026" for a @db.Date (stored at UTC midnight). */
function formatDate(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(d);
}

// ─── Sending ─────────────────────────────────────────────────────────────

/**
 * Send (or with `force`, re-send) the customer's email for one signed note.
 * Never throws.
 */
export async function sendCreditNoteEmail(
  tenantId: string,
  creditNoteId: string,
  opts: { force?: boolean; userName?: string | null } = {}
): Promise<CreditEmailResult> {
  const db = scopedPrisma(tenantId);
  try {
    const note = await db.creditNote.findFirst({
      where: { id: creditNoteId },
      select: {
        id: true,
        status: true,
        creditNo: true,
        invoiceNo: true,
        collectionRef: true,
        creditDate: true,
        deliverToName: true,
        billToName: true,
        signedAt: true,
        signedFileId: true,
        signedFilename: true,
        emailStatus: true,
        emailRecipient: true,
        invoice: { select: { customerName: true, deliverToName: true, billToName: true } },
        collections: {
          where: { source: { in: ["AUTO", "MANUAL"] } },
          select: { collection: { select: { collectionNo: true, customerName: true } } },
        },
      },
    });
    if (!note) return { outcome: "not_found" };
    if (note.status !== "SIGNED" || !note.signedAt || !note.signedFileId || !note.creditNo) return { outcome: "not_ready" };

    const names = recipientNames({
      invoiceCustomer: note.invoice?.customerName,
      collectionCustomers: note.collections.map((l) => l.collection.customerName),
      noteDeliverTo: note.deliverToName,
      invoiceDeliverTo: note.invoice?.deliverToName,
      noteBillTo: note.billToName,
      invoiceBillTo: note.invoice?.billToName,
    });
    const contacts = names.length
      ? await db.contact.findMany({
          where: { deletedAt: null },
          select: { id: true, companyName: true, email: true, contactPerson: true },
        })
      : [];
    const recipient = pickRecipient(names, contacts);
    if (!recipient) {
      // Not a failure to retry: no resend invents an address. The names
      // searched are kept so the office knows which contact to fix.
      await db.creditNote.updateMany({
        where: { id: creditNoteId, emailStatus: { not: "SENDING" } },
        data: {
          emailStatus: "NO_EMAIL",
          emailError: names.length
            ? `No contact with an email address is named ${names.map((n) => `"${n}"`).join(" or ")}`
            : "The note and its invoice name no customer",
        },
      });
      return { outcome: "no_email" };
    }
    if (note.emailStatus === "SENT" && !opts.force) {
      return { outcome: "already_sent", recipient: note.emailRecipient ?? recipient.email };
    }

    // ── Claim ──
    const claimable: Record<string, unknown>[] = [
      { emailStatus: { in: ["NOT_SENT", "FAILED", "NO_EMAIL"] } },
      { emailStatus: "SENDING", OR: [{ emailLastAttemptAt: null }, { emailLastAttemptAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }] },
    ];
    if (opts.force) claimable.push({ emailStatus: "SENT" });
    const claim = await db.creditNote.updateMany({
      where: { id: creditNoteId, status: "SIGNED", OR: claimable },
      data: { emailStatus: "SENDING", emailLastAttemptAt: new Date(), emailAttempts: { increment: 1 } },
    });
    if (claim.count === 0) return { outcome: "in_flight", recipient: recipient.email };

    // ── Build and send ──
    let pdf: Buffer;
    try {
      pdf = await downloadFileById(tenantId, note.signedFileId);
    } catch (err) {
      const error = `The signed copy could not be read from OneDrive: ${err instanceof Error ? err.message : String(err)}`;
      await db.creditNote.updateMany({ where: { id: creditNoteId }, data: { emailStatus: "FAILED", emailError: error } });
      return { outcome: "failed", recipient: recipient.email, error };
    }
    const attach = pdf.length <= MAX_ATTACHMENT_BYTES;
    const collectionNos = note.collections.length
      ? note.collections.map((l) => l.collection.collectionNo)
      : note.collectionRef
        ? [note.collectionRef]
        : [];

    const result = await sendCreditNoteSigned({
      customerEmail: recipient.email,
      customerName: recipient.companyName,
      contactPerson: recipient.contactPerson ?? undefined,
      companyName: (await readCustomerFacingCompany(tenantId)) || "Signex",
      creditNo: note.creditNo,
      invoiceNo: note.invoiceNo,
      collectionNos,
      creditDate: note.creditDate ? formatDate(note.creditDate) : null,
      signedAt: formatStampTime(note.signedAt),
      ...(attach && { attachment: { filename: note.signedFilename || `CN${note.creditNo}.pdf`, content: pdf } }),
    });

    if (result.success) {
      await db.creditNote.updateMany({
        where: { id: creditNoteId },
        data: { emailStatus: "SENT", emailSentAt: new Date(), emailRecipient: recipient.email, emailError: null },
      });
      await logAudit({
        action: "STATUS_CHANGE",
        entity: "credit_note",
        entityId: creditNoteId,
        userName: opts.userName ?? undefined,
        details: `${note.emailStatus === "SENT" ? "Credit note emailed again" : "Credit note emailed"} to ${recipient.email}${attach ? " (signed copy attached)" : " (signed copy too large to attach)"}`,
        tenantId,
      });
      return { outcome: "sent", recipient: recipient.email };
    }

    const error = result.error ?? "The mail server rejected the message";
    await db.creditNote.updateMany({ where: { id: creditNoteId }, data: { emailStatus: "FAILED", emailError: error } });
    return { outcome: "failed", recipient: recipient.email, error };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`[credit-note-email] Note ${creditNoteId}:`, err);
    try {
      await db.creditNote.updateMany({ where: { id: creditNoteId, emailStatus: "SENDING" }, data: { emailStatus: "FAILED", emailError: error } });
    } catch {
      // The lease lets the office retry regardless.
    }
    return { outcome: "failed", error };
  }
}
