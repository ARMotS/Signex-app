/**
 * courier-confirm.ts
 * The customer's side of a courier delivery: the email telling them their
 * invoices were collected by a courier — which courier, which driver, which
 * waybills — with the signed copies attached. It is a delivery confirmation,
 * like the one a customer gets when one of our own drivers delivers: the
 * customer is asked for nothing (user decision, 2026-11-18). The sheet is
 * complete the moment the courier driver signs; there is no Confirm received
 * and no reminder (removed 2026-11-12). The office's Resend is the only way a
 * second email goes.
 *
 * The email goes out by itself once every signed copy is filed (it carries
 * them). Like the delivery confirmation, nothing here throws and nothing here
 * can undo the handover: a failure is recorded on the sheet and picked up by
 * the office's Send or the daily job (lib/courier-confirm-job.ts). Sending
 * CLAIMS the sheet first with the same lease as Stop.emailStatus, so the
 * automatic send, the daily job and the office's Send never double-mail.
 *
 * ── Links already sent ────────────────────────────────────────────────────
 * Emails sent before 2026-11-18 carry a /delivery/<token> link (30 days). The
 * page still opens, read-only, showing the delivery; nothing confirms any
 * more and no new link is issued. The token is looked up by its SHA-256
 * (`confirmTokenHash`) and is the credential, the way a session token is: the
 * scope is the scope of the row it finds. Once the last link has expired the
 * page, the lookup and the token columns can go (expand/contract).
 */

import crypto from "crypto";
import { after } from "next/server";
import { scopedPrisma, UNSAFE_unscopedPrisma } from "./db-scoped";
import { logAudit } from "./audit";
import { sendCourierDispatch } from "./email";
import { readSignedPdf } from "./delivery-notify";
import { readDispatchCompany } from "./config";
import {
  COURIER_ACTIVE_STATUSES,
  COURIER_COMPLETED_STATUSES,
  companyKey,
  confirmationState,
  NEEDS_OFFICE,
  type ConfirmationState,
} from "./courier-sheet";
import { formatStampTime, STAMP_TIME_ZONE } from "./courier-stamp-text";

/** Failed emails the daily job retries by itself; past this, the office's Send. */
export const MAX_AUTO_ATTEMPTS = 5;
const STALE_CLAIM_MS = 2 * 60 * 1000;
/** Mail relays refuse large messages; copies past this are named instead of attached. */
const MAX_ATTACHMENT_BYTES = 15_000_000;

const COMPLETED = [...COURIER_COMPLETED_STATUSES];

// ─── Pure parts ──────────────────────────────────────────────────────────

/** The lookup hash, or null when the string cannot be one of our tokens. */
export function hashConfirmToken(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token ?? ""))) return null;
  return crypto.createHash("sha256").update(token).digest("hex");
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
  courierDriverName: true,
  dispatchCompany: true,
  waybills: true,
  parcels: true,
  collectedAt: true,
  filingCompletedAt: true,
  emailStatus: true,
  emailSentAt: true,
  emailRecipient: true,
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

/**
 * Send (or with `force`, re-send) the customer's email for one completed
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
    // DELIVERED: a sheet a customer confirmed before confirming was retired —
    // completed all the same, and the office may still resend its email.
    if (!(COMPLETED as string[]).includes(sheet.status) || !sheet.filingCompletedAt) return { outcome: "not_ready" };

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
      where: { id, status: { in: COMPLETED }, OR: claimable },
      data: { emailStatus: "SENDING", emailLastAttemptAt: new Date(), emailAttempts: { increment: 1 }, customerEmail: recipient.email },
    });
    if (claim.count === 0) return { outcome: "in_flight", recipient: recipient.email };

    // ── Build and send ──
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
      courierDriverName: sheet.courierDriverName ?? undefined,
      courierSheetNo: sheet.courierSheetNo,
      waybills: sheet.waybills,
      parcels: sheet.parcels,
      invoiceNos: sheet.invoices.map((i) => i.invoiceNo),
      collectedAt: formatStampTime(sheet.collectedAt ?? new Date()),
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
    where: { status: { in: COMPLETED }, filingCompletedAt: { not: null }, emailStatus: { in: ["NO_EMAIL", "NOT_SENT"] } },
    select: { id: true },
    take: 20,
  });
  for (const s of waiting) await scheduleCourierConfirmation(tenantId, s.id);
}

// ─── Links already sent (read-only) ──────────────────────────────────────

export interface DeliveryView {
  companyName: string;
  customerName: string;
  courierSheetNo: string;
  courierCompany: string | null;
  courierDriverName: string | null;
  waybills: string[];
  parcels: number | null;
  invoiceNos: string[];
  collectedAt: string;
}

export type DeliveryLookup =
  | { state: "not_found" }
  | { state: "expired"; companyName: string }
  | { state: "open"; view: DeliveryView };

/** What an older email's link shows. Read-only: nothing is confirmed. */
export async function readDelivery(token: string, now = new Date()): Promise<DeliveryLookup> {
  const hash = hashConfirmToken(token);
  if (!hash) return { state: "not_found" };
  // SCOPE-EXEMPT: the link is the credential (no session exists on a
  // customer's visit), like a session token check. It finds exactly one row
  // by a 256-bit secret; everything after is done in that row's own scope.
  const row = await UNSAFE_unscopedPrisma.courierTripSheet.findUnique({
    where: { confirmTokenHash: hash },
    select: { id: true, tenantId: true },
  });
  if (!row) return { state: "not_found" };
  const sheet = await scopedPrisma(row.tenantId).courierTripSheet.findFirst({
    where: { id: row.id },
    select: {
      courierSheetNo: true,
      customerName: true,
      courierCompany: true,
      courierDriverName: true,
      dispatchCompany: true,
      waybills: true,
      parcels: true,
      collectedAt: true,
      confirmTokenExpiresAt: true,
      invoices: { orderBy: { lineNo: "asc" }, select: { invoiceNo: true } },
    },
  });
  if (!sheet) return { state: "not_found" };
  const companyName = sheet.dispatchCompany || (await readDispatchCompany(row.tenantId)) || "Signex";
  if (!sheet.confirmTokenExpiresAt || sheet.confirmTokenExpiresAt <= now) return { state: "expired", companyName };
  return {
    state: "open",
    view: {
      companyName,
      customerName: sheet.customerName,
      courierSheetNo: sheet.courierSheetNo,
      courierCompany: sheet.courierCompany,
      courierDriverName: sheet.courierDriverName,
      waybills: sheet.waybills,
      parcels: sheet.parcels,
      invoiceNos: sheet.invoices.map((i) => i.invoiceNo),
      collectedAt: formatStampTime(sheet.collectedAt ?? now),
    },
  };
}

// ─── The office's view ───────────────────────────────────────────────────

export interface CourierAttentionItem {
  id: string;
  courierSheetNo: string;
  customerName: string;
  /** NEEDS_ATTENTION before the handover, else what still follows it. */
  state: "needs_attention" | ConfirmationState;
}

export interface CourierOverview {
  needsAttention: number;
  awaitingCollection: number;
  /** Signed for by the courier since the start of today. */
  completedToday: number;
  /** Still open: needs attention + awaiting collection — the nav badge. */
  active: number;
  /** What the office has to act on: fixes before the handover, copies not filed, emails not sent. */
  attention: number;
  items: CourierAttentionItem[];
  /** For dashboards on the previous bundle: nothing awaits a confirmation now. */
  awaitingConfirmation: 0;
  /** For dashboards on the previous bundle: the same figure as completedToday. */
  confirmedToday: number;
}

/**
 * The scope's courier sheets as the dashboard card and the branch overview
 * read them. Database only (the dashboard is polled all day) and scoped.
 * Completed sheets are read only while something still follows them — the
 * card used to read every collected sheet ever, waiting for a confirmation.
 */
export async function courierOverview(tenantId: string, todayStart: Date): Promise<CourierOverview> {
  const db = scopedPrisma(tenantId);
  const [grouped, completedToday, open, followUps] = await Promise.all([
    db.courierTripSheet.groupBy({
      by: ["status"],
      where: { status: { in: [...COURIER_ACTIVE_STATUSES] } },
      _count: { _all: true },
    }),
    db.courierTripSheet.count({ where: { status: { in: COMPLETED }, collectedAt: { gte: todayStart } } }),
    db.courierTripSheet.findMany({
      where: { status: "NEEDS_ATTENTION" },
      orderBy: { sheetDate: "asc" },
      take: 8,
      select: { id: true, courierSheetNo: true, customerName: true },
    }),
    db.courierTripSheet.findMany({
      where: {
        status: { in: COMPLETED },
        OR: [{ filingCompletedAt: null }, { emailStatus: { in: ["FAILED", "NO_EMAIL"] } }],
      },
      orderBy: { collectedAt: "asc" },
      take: 500,
      select: { id: true, courierSheetNo: true, customerName: true, status: true, filingCompletedAt: true, emailStatus: true },
    }),
  ]);

  const count = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const needsAttention = count("NEEDS_ATTENTION");
  const awaitingCollection = count("AWAITING_COLLECTION");
  const items: CourierAttentionItem[] = open.map((r) => ({ ...r, state: "needs_attention" }));
  let followUpCount = 0;
  for (const r of followUps) {
    const state = confirmationState(r);
    if (!state || !NEEDS_OFFICE.includes(state)) continue;
    followUpCount++;
    items.push({ id: r.id, courierSheetNo: r.courierSheetNo, customerName: r.customerName, state });
  }
  return {
    needsAttention,
    awaitingCollection,
    completedToday,
    active: needsAttention + awaitingCollection,
    attention: needsAttention + followUpCount,
    items: items.slice(0, 8),
    awaitingConfirmation: 0,
    confirmedToday: completedToday,
  };
}
