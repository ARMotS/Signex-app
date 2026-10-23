/**
 * courier-confirm.ts
 * The customer's side of a courier delivery: the email telling them their
 * invoices left with a courier, the one reminder, and the link they press
 * once the parcels arrive.
 *
 * The first email goes out by itself once every signed copy is filed (it
 * carries them). Like the delivery confirmation, nothing here throws and
 * nothing here can undo the handover: a failure is recorded on the sheet and
 * picked up by the office's Send or the daily job (lib/courier-confirm-job.ts).
 * Sending CLAIMS the sheet first with the same lease as Stop.emailStatus, so
 * the automatic send, the daily job and the office's Send never double-mail.
 *
 * ── The link ──────────────────────────────────────────────────────────────
 * /delivery/<token>: 32 random bytes, no login, one per sheet, 30 days. It is
 * looked up by its SHA-256 (`confirmTokenHash`), so the database alone holds
 * no working link; the reminder re-sends the SAME link from an encrypted copy
 * (`confirmTokenEnc`, TOKEN_ENCRYPTION_KEY). Opening the link only shows the
 * delivery — confirming is a POST — because mail scanners open links.
 *
 * The token is the credential, the way a session token is: a visit has no
 * session, and the scope is the scope of the row the token finds.
 */

import crypto from "crypto";
import { after } from "next/server";
import { scopedPrisma, UNSAFE_unscopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import { decryptToken, encryptToken } from "./crypto";
import { sendCourierDispatch } from "./email";
import { readSignedPdf } from "./delivery-notify";
import { readDispatchCompany } from "./config";
import { companyKey, confirmationState, NEEDS_OFFICE, type ConfirmationState } from "./courier-sheet";
import { formatStampTime, STAMP_TIME_ZONE } from "./courier-stamp-text";
import { appBaseUrl } from "./app-url";

export const LINK_DAYS = 30;
export const REMINDER_AFTER_DAYS = 2;
/** Failed first emails the daily job retries by itself; past this, the office's Send. */
export const MAX_AUTO_ATTEMPTS = 5;
const STALE_CLAIM_MS = 2 * 60 * 1000;
/** Mail relays refuse large messages; copies past this are named instead of attached. */
const MAX_ATTACHMENT_BYTES = 15_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Pure parts ──────────────────────────────────────────────────────────

/** A new link token and the hash it is looked up by. */
export function newConfirmToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashConfirmToken(token)! };
}

/** The lookup hash, or null when the string cannot be one of our tokens. */
export function hashConfirmToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token ?? ""))) return null;
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function confirmUrl(token: string, base = appBaseUrl()): string {
  return `${base}/delivery/${token}`;
}

/** YYYY-MM-DD in Johannesburg. */
const sastDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: STAMP_TIME_ZONE }).format(d);

/**
 * The reminder is due on the second calendar day (South African) after the
 * email: sent Monday, reminded Wednesday — whatever time the daily job runs.
 */
export function reminderDue(sentAt: Date, now: Date): boolean {
  const days = (Date.parse(sastDay(now)) - Date.parse(sastDay(sentAt))) / DAY_MS;
  return days >= REMINDER_AFTER_DAYS;
}

/** "22 Nov 2026" in Johannesburg. */
export function formatDay(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: STAMP_TIME_ZONE, day: "numeric", month: "short", year: "numeric" }).format(d);
}

// ─── Sending ─────────────────────────────────────────────────────────────

export type CourierEmailOutcome =
  | "sent"
  | "failed"
  | "no_email"
  | "already_sent"
  | "in_flight"
  /** Not collected yet, or its signed copies are not all filed. */
  | "not_ready"
  /** The customer has already confirmed. */
  | "confirmed"
  | "not_found";

export interface CourierEmailResult {
  outcome: CourierEmailOutcome;
  recipient?: string;
  error?: string;
}

const SHEET_SELECT = {
  id: true,
  status: true,
  courierSheetNo: true,
  customerName: true,
  contactId: true,
  customerEmail: true,
  courierCompany: true,
  dispatchCompany: true,
  waybills: true,
  parcels: true,
  collectedAt: true,
  filingCompletedAt: true,
  emailStatus: true,
  emailSentAt: true,
  emailRecipient: true,
  confirmTokenEnc: true,
  confirmTokenExpiresAt: true,
  reminderSentAt: true,
  invoices: {
    orderBy: { lineNo: "asc" as const },
    select: { invoiceNo: true, signedAt: true, signedFileName: true },
  },
} as const;

/**
 * Who the email goes to, as of now: the linked contact, else the one whose
 * company name matches exactly (never fuzzily — an email goes to it). Read
 * at send time, so an address added after the handover is the one used.
 */
async function resolveRecipient(tenantId: string, sheet: { contactId: string | null; customerName: string }) {
  const db = scopedPrisma(tenantId);
  if (sheet.contactId) {
    const c = await db.contact.findFirst({
      where: { id: sheet.contactId, deletedAt: null },
      select: { id: true, email: true, contactPerson: true },
    });
    return c ? { contactId: c.id, email: c.email?.trim() || null, contactPerson: c.contactPerson } : null;
  }
  const key = companyKey(sheet.customerName);
  const named = (
    await db.contact.findMany({ where: { deletedAt: null }, select: { id: true, companyName: true, email: true, contactPerson: true } })
  ).filter((c) => companyKey(c.companyName) === key);
  const c = named.find((x) => x.email?.trim()) ?? named[0];
  return c ? { contactId: c.id, email: c.email?.trim() || null, contactPerson: c.contactPerson } : null;
}

/** The sheet's link token: the live one, or a new one when there is none or it expired. */
async function linkToken(tenantId: string, sheet: { id: string; confirmTokenEnc: string | null; confirmTokenExpiresAt: Date | null }) {
  if (sheet.confirmTokenEnc && sheet.confirmTokenExpiresAt && sheet.confirmTokenExpiresAt > new Date()) {
    try {
      return { token: decryptToken(sheet.confirmTokenEnc), expiresAt: sheet.confirmTokenExpiresAt };
    } catch {
      // A rotated key: the old link is unreadable — issue a new one below.
    }
  }
  const { token, hash } = newConfirmToken();
  const expiresAt = new Date(Date.now() + LINK_DAYS * DAY_MS);
  await scopedPrisma(tenantId).courierTripSheet.updateMany({
    where: { id: sheet.id },
    data: { confirmTokenHash: hash, confirmTokenEnc: encryptToken(token), confirmTokenExpiresAt: expiresAt },
  });
  return { token, expiresAt };
}

/**
 * Send (or with `force`, re-send) the customer's email for one collected
 * sheet. Never throws.
 */
export async function sendCourierConfirmation(
  tenantId: string,
  id: string,
  opts: { force?: boolean; userName?: string | null } = {}
): Promise<CourierEmailResult> {
  const db = scopedPrisma(tenantId);
  try {
    const sheet = await db.courierTripSheet.findFirst({ where: { id }, select: SHEET_SELECT });
    if (!sheet) return { outcome: "not_found" };
    if (sheet.status === "DELIVERED") return { outcome: "confirmed" };
    if (sheet.status !== "COLLECTED" || !sheet.filingCompletedAt) return { outcome: "not_ready" };

    const recipient = await resolveRecipient(tenantId, sheet);
    if (recipient && recipient.contactId !== sheet.contactId) {
      await db.courierTripSheet.updateMany({ where: { id }, data: { contactId: recipient.contactId } });
    }
    if (!recipient?.email) {
      // Not a failure to retry: no resend invents an address.
      await db.courierTripSheet.updateMany({
        where: { id, emailStatus: { not: "SENDING" } },
        data: { emailStatus: "NO_EMAIL", emailError: null, customerEmail: null },
      });
      return { outcome: "no_email" };
    }
    if (sheet.emailStatus === "SENT" && !opts.force) {
      return { outcome: "already_sent", recipient: sheet.emailRecipient ?? recipient.email };
    }

    // ── Claim ──
    const claimable: Record<string, unknown>[] = [
      { emailStatus: { in: ["NOT_SENT", "FAILED", "NO_EMAIL"] } },
      { emailStatus: "SENDING", OR: [{ emailLastAttemptAt: null }, { emailLastAttemptAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } }] },
    ];
    if (opts.force) claimable.push({ emailStatus: "SENT" });
    const claim = await db.courierTripSheet.updateMany({
      where: { id, status: "COLLECTED", OR: claimable },
      data: { emailStatus: "SENDING", emailLastAttemptAt: new Date(), emailAttempts: { increment: 1 }, customerEmail: recipient.email },
    });
    if (claim.count === 0) return { outcome: "in_flight", recipient: recipient.email };

    // ── Build and send ──
    const { token, expiresAt } = await linkToken(tenantId, sheet);
    const attachments: { filename: string; content: Buffer }[] = [];
    const notAttached: string[] = [];
    let bytes = 0;
    for (const inv of sheet.invoices) {
      const pdf = inv.signedAt && inv.signedFileName ? await readSignedPdf(tenantId, inv.signedFileName) : undefined;
      if (pdf && bytes + pdf.content.length <= MAX_ATTACHMENT_BYTES) {
        attachments.push(pdf);
        bytes += pdf.content.length;
      } else {
        notAttached.push(inv.invoiceNo);
      }
    }
    const companyName = sheet.dispatchCompany || (await readDispatchCompany(tenantId)) || "Signex";

    const result = await sendCourierDispatch({
      customerEmail: recipient.email,
      customerName: sheet.customerName,
      contactPerson: recipient.contactPerson ?? undefined,
      companyName,
      courierCompany: sheet.courierCompany || "the courier",
      courierSheetNo: sheet.courierSheetNo,
      waybills: sheet.waybills,
      parcels: sheet.parcels,
      invoiceNos: sheet.invoices.map((i) => i.invoiceNo),
      collectedAt: formatStampTime(sheet.collectedAt ?? new Date()),
      confirmUrl: confirmUrl(token),
      expiresOn: formatDay(expiresAt),
      attachments,
      notAttached,
    });

    if (result.success) {
      await db.courierTripSheet.updateMany({
        where: { id },
        data: { emailStatus: "SENT", emailSentAt: new Date(), emailRecipient: recipient.email, emailError: null },
      });
      await logAudit({
        action: "STATUS_CHANGE",
        entity: "courier_sheet",
        entityId: id,
        userName: opts.userName ?? undefined,
        details: `${sheet.emailStatus === "SENT" ? "Confirmation email sent again" : "Confirmation email sent"} to ${recipient.email} (${attachments.length} signed cop${attachments.length === 1 ? "y" : "ies"} attached)`,
        tenantId,
      });
      return { outcome: "sent", recipient: recipient.email };
    }

    const error = result.error ?? "The mail server rejected the message";
    await db.courierTripSheet.updateMany({ where: { id }, data: { emailStatus: "FAILED", emailError: error } });
    return { outcome: "failed", recipient: recipient.email, error };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`[courier-confirm] Sheet ${id}:`, err);
    try {
      await db.courierTripSheet.updateMany({ where: { id, emailStatus: "SENDING" }, data: { emailStatus: "FAILED", emailError: error } });
    } catch {
      // The lease lets the office retry regardless.
    }
    return { outcome: "failed", error };
  }
}

/**
 * Send the email after the response, falling back to inline where there is
 * no request to defer past (after() throws there) — as
 * scheduleDeliveryConfirmation.
 */
export async function scheduleCourierConfirmation(tenantId: string, id: string): Promise<void> {
  const run = async () => {
    const r = await sendCourierConfirmation(tenantId, id);
    if (r.outcome === "failed") console.warn(`[courier-confirm] Email for sheet ${id} failed (${r.error}); the office can resend`);
  };
  try {
    after(run);
  } catch {
    await run();
  }
}

/**
 * Sheets whose email waits for an address — sent as soon as one may exist
 * (a contact was saved). Bounded; the daily job catches the rest.
 */
export async function scheduleWaitingCourierEmails(tenantId: string): Promise<void> {
  const waiting = await scopedPrisma(tenantId).courierTripSheet.findMany({
    where: { status: "COLLECTED", filingCompletedAt: { not: null }, emailStatus: { in: ["NO_EMAIL", "NOT_SENT"] } },
    select: { id: true },
    take: 20,
  });
  for (const s of waiting) await scheduleCourierConfirmation(tenantId, s.id);
}

/**
 * The one reminder, on the second day after the email, while unconfirmed.
 * Claimed by setting reminderSentAt, cleared again when the send fails so the
 * next day's run tries again. Never throws.
 */
export async function sendCourierReminder(tenantId: string, id: string, now = new Date()): Promise<CourierEmailResult> {
  const db = scopedPrisma(tenantId);
  try {
    const sheet = await db.courierTripSheet.findFirst({ where: { id }, select: SHEET_SELECT });
    if (!sheet) return { outcome: "not_found" };
    if (sheet.status === "DELIVERED") return { outcome: "confirmed" };
    if (
      sheet.status !== "COLLECTED" ||
      sheet.emailStatus !== "SENT" ||
      !sheet.emailSentAt ||
      sheet.reminderSentAt ||
      !sheet.confirmTokenEnc ||
      !sheet.confirmTokenExpiresAt ||
      sheet.confirmTokenExpiresAt <= now ||
      !reminderDue(sheet.emailSentAt, now)
    ) {
      return { outcome: "not_ready" };
    }

    const recipient = await resolveRecipient(tenantId, sheet);
    const email = recipient?.email || sheet.emailRecipient;
    if (!email) return { outcome: "no_email" };

    const claim = await db.courierTripSheet.updateMany({
      where: { id, status: "COLLECTED", reminderSentAt: null },
      data: { reminderSentAt: now },
    });
    if (claim.count === 0) return { outcome: "in_flight" };

    const result = await sendCourierDispatch({
      customerEmail: email,
      customerName: sheet.customerName,
      contactPerson: recipient?.contactPerson ?? undefined,
      companyName: sheet.dispatchCompany || (await readDispatchCompany(tenantId)) || "Signex",
      courierCompany: sheet.courierCompany || "the courier",
      courierSheetNo: sheet.courierSheetNo,
      waybills: sheet.waybills,
      parcels: sheet.parcels,
      invoiceNos: sheet.invoices.map((i) => i.invoiceNo),
      collectedAt: formatStampTime(sheet.collectedAt ?? now),
      confirmUrl: confirmUrl(decryptToken(sheet.confirmTokenEnc)),
      expiresOn: formatDay(sheet.confirmTokenExpiresAt),
      reminder: true,
      attachments: [],
    });

    if (!result.success) {
      await db.courierTripSheet.updateMany({ where: { id, status: "COLLECTED" }, data: { reminderSentAt: null } });
      await logAudit({
        action: "STATUS_CHANGE",
        entity: "courier_sheet",
        entityId: id,
        details: `Reminder email to ${email} failed (tried again tomorrow): ${result.error ?? "rejected"}`,
        tenantId,
      });
      return { outcome: "failed", recipient: email, error: result.error };
    }
    await logAudit({ action: "STATUS_CHANGE", entity: "courier_sheet", entityId: id, details: `Reminder email sent to ${email}`, tenantId });
    return { outcome: "sent", recipient: email };
  } catch (err) {
    console.error(`[courier-confirm] Reminder for sheet ${id}:`, err);
    return { outcome: "failed", error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── The customer's link ─────────────────────────────────────────────────

/** The row a link points at, in whichever scope it is. */
async function findByToken(token: string) {
  const hash = hashConfirmToken(token);
  if (!hash) return null;
  // SCOPE-EXEMPT: the link is the credential (no session exists on a
  // customer's visit), like a session token check. It finds exactly one row
  // by a 256-bit secret; everything after is done in that row's own scope.
  const row = await UNSAFE_unscopedPrisma.courierTripSheet.findUnique({
    where: { confirmTokenHash: hash },
    select: { id: true, tenantId: true, status: true, confirmedAt: true, confirmTokenExpiresAt: true },
  });
  return row ? { ...row, hash } : null;
}

export interface DeliveryView {
  companyName: string;
  customerName: string;
  courierSheetNo: string;
  courierCompany: string | null;
  waybills: string[];
  parcels: number | null;
  invoiceNos: string[];
  collectedAt: string;
  confirmedAt: string | null;
  expiresOn: string;
}

export type DeliveryLookup =
  | { state: "not_found" }
  | { state: "expired"; companyName: string }
  | { state: "open" | "confirmed"; view: DeliveryView };

/** What the link's page shows. Read-only: opening the link confirms nothing. */
export async function readDelivery(token: string, now = new Date()): Promise<DeliveryLookup> {
  const row = await findByToken(token);
  if (!row) return { state: "not_found" };
  const sheet = await scopedPrisma(row.tenantId).courierTripSheet.findFirst({
    where: { id: row.id },
    select: {
      courierSheetNo: true,
      customerName: true,
      courierCompany: true,
      dispatchCompany: true,
      waybills: true,
      parcels: true,
      collectedAt: true,
      confirmedAt: true,
      confirmTokenExpiresAt: true,
      invoices: { orderBy: { lineNo: "asc" }, select: { invoiceNo: true } },
    },
  });
  if (!sheet) return { state: "not_found" };
  const companyName = sheet.dispatchCompany || (await readDispatchCompany(row.tenantId)) || "Signex";
  const expired = !sheet.confirmTokenExpiresAt || sheet.confirmTokenExpiresAt <= now;
  if (expired && !sheet.confirmedAt) return { state: "expired", companyName };
  return {
    state: sheet.confirmedAt ? "confirmed" : "open",
    view: {
      companyName,
      customerName: sheet.customerName,
      courierSheetNo: sheet.courierSheetNo,
      courierCompany: sheet.courierCompany,
      waybills: sheet.waybills,
      parcels: sheet.parcels,
      invoiceNos: sheet.invoices.map((i) => i.invoiceNo),
      collectedAt: formatStampTime(sheet.collectedAt ?? now),
      confirmedAt: sheet.confirmedAt ? formatStampTime(sheet.confirmedAt) : null,
      expiresOn: sheet.confirmTokenExpiresAt ? formatDay(sheet.confirmTokenExpiresAt) : "",
    },
  };
}

export type ConfirmOutcome = "confirmed" | "already_confirmed" | "expired" | "not_found";

/** The customer pressed Confirm received. Idempotent; one conditional update. */
export async function confirmDelivery(token: string, now = new Date()): Promise<{ outcome: ConfirmOutcome; confirmedAt?: string }> {
  const row = await findByToken(token);
  if (!row) return { outcome: "not_found" };
  if (row.confirmedAt) return { outcome: "already_confirmed", confirmedAt: formatStampTime(row.confirmedAt) };
  if (!row.confirmTokenExpiresAt || row.confirmTokenExpiresAt <= now) return { outcome: "expired" };

  const db = scopedPrisma(row.tenantId);
  const done = await db.courierTripSheet.updateMany({
    where: { id: row.id, status: "COLLECTED", confirmTokenHash: row.hash, confirmedAt: null },
    data: { status: "DELIVERED", confirmedAt: now },
  });
  if (done.count === 0) {
    const again = await db.courierTripSheet.findFirst({ where: { id: row.id }, select: { confirmedAt: true } });
    return again?.confirmedAt
      ? { outcome: "already_confirmed", confirmedAt: formatStampTime(again.confirmedAt) }
      : { outcome: "not_found" };
  }
  await logAudit({
    action: "STATUS_CHANGE",
    entity: "courier_sheet",
    entityId: row.id,
    userName: "Customer (email link)",
    details: "Customer confirmed the delivery arrived",
    tenantId: row.tenantId,
  });
  return { outcome: "confirmed", confirmedAt: formatStampTime(now) };
}

// ─── The office's view ───────────────────────────────────────────────────

export interface CourierAttentionItem {
  id: string;
  courierSheetNo: string;
  customerName: string;
  /** NEEDS_ATTENTION before the handover, else the confirmation state. */
  state: "needs_attention" | ConfirmationState;
}

export interface CourierOverview {
  needsAttention: number;
  awaitingCollection: number;
  /** Collected and not yet confirmed, in any state. */
  awaitingConfirmation: number;
  confirmedToday: number;
  /** What the office has to act on — what the nav badge counts. */
  attention: number;
  items: CourierAttentionItem[];
}

/**
 * The scope's courier sheets as the dashboard card and the nav badge read
 * them. Database only (the dashboard is polled all day) and scoped.
 */
export async function courierOverview(tenantId: string, todayStart: Date, now = new Date()): Promise<CourierOverview> {
  const rows = await scopedPrisma(tenantId).courierTripSheet.findMany({
    where: {
      OR: [
        { status: { in: ["NEEDS_ATTENTION", "AWAITING_COLLECTION", "COLLECTED"] } },
        { status: "DELIVERED", confirmedAt: { gte: todayStart } },
      ],
    },
    orderBy: { sheetDate: "asc" },
    take: 1000,
    select: {
      id: true,
      courierSheetNo: true,
      customerName: true,
      status: true,
      filingCompletedAt: true,
      emailStatus: true,
      reminderSentAt: true,
      confirmedAt: true,
    },
  });
  const out: CourierOverview = { needsAttention: 0, awaitingCollection: 0, awaitingConfirmation: 0, confirmedToday: 0, attention: 0, items: [] };
  for (const r of rows) {
    if (r.status === "NEEDS_ATTENTION") {
      out.needsAttention++;
      out.items.push({ id: r.id, courierSheetNo: r.courierSheetNo, customerName: r.customerName, state: "needs_attention" });
      continue;
    }
    if (r.status === "AWAITING_COLLECTION") {
      out.awaitingCollection++;
      continue;
    }
    const state = confirmationState(r, now);
    if (state === "confirmed") {
      out.confirmedToday++;
      continue;
    }
    out.awaitingConfirmation++;
    if (state && NEEDS_OFFICE.includes(state)) {
      out.items.push({ id: r.id, courierSheetNo: r.courierSheetNo, customerName: r.customerName, state });
    }
  }
  out.attention = out.items.length;
  out.items = out.items.slice(0, 8);
  return out;
}
