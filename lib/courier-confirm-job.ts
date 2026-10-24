/**
 * courier-confirm-job.ts
 * The daily job (Vercel Cron, /api/cron/courier-confirmations): for every
 * scope, finish what the courier handover left waiting.
 *
 *  1. Signed copies not all filed (OneDrive was down) — file them; the email
 *     follows by itself once they are.
 *  2. A first email that has not gone: never tried, no address yet (one may
 *     have been added), failed (up to MAX_AUTO_ATTEMPTS), or a stale claim.
 *  3. The one reminder, on the second day after the email.
 *
 * Bounded by a time budget so one slow OneDrive never runs the function out;
 * whatever is left is the next day's work (or the office's Send).
 */

import { UNSAFE_unscopedPrisma } from "./db-scoped";
import { fileCourierSheet } from "./courier-collect";
import { MAX_AUTO_ATTEMPTS, sendCourierConfirmation, sendCourierReminder } from "./courier-confirm";

const BATCH = 200;
const STALE_CLAIM_MS = 2 * 60 * 1000;

export interface JobSummary {
  looked: number;
  filed: number;
  sent: number;
  reminded: number;
  failed: number;
  /** Rows left for the next run because the time budget ran out. */
  deferred: number;
}

export async function runCourierConfirmationJob(now = new Date(), budgetMs = 45_000): Promise<JobSummary> {
  const started = Date.now();
  // SCOPE-EXEMPT: the scheduled job serves every scope and has no session.
  // It only picks row ids here; each row is then handled through its own
  // scope's client, exactly as the office's own actions would be.
  const rows = await UNSAFE_unscopedPrisma.courierTripSheet.findMany({
    where: {
      status: "COLLECTED",
      OR: [
        { filingCompletedAt: null, driverSignature: { not: null } },
        { filingCompletedAt: { not: null }, emailStatus: { in: ["NOT_SENT", "NO_EMAIL"] } },
        { filingCompletedAt: { not: null }, emailStatus: "FAILED", emailAttempts: { lt: MAX_AUTO_ATTEMPTS } },
        { filingCompletedAt: { not: null }, emailStatus: "SENDING", emailLastAttemptAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
        { emailStatus: "SENT", reminderSentAt: null, emailSentAt: { lte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      ],
    },
    orderBy: { collectedAt: "asc" },
    take: BATCH,
    select: { id: true, tenantId: true, filingCompletedAt: true, emailStatus: true },
  });

  const summary: JobSummary = { looked: rows.length, filed: 0, sent: 0, reminded: 0, failed: 0, deferred: 0 };
  for (const [i, row] of rows.entries()) {
    if (Date.now() - started > budgetMs) {
      summary.deferred = rows.length - i;
      break;
    }
    try {
      if (!row.filingCompletedAt) {
        const filing = await fileCourierSheet(row.tenantId, row.id, "Daily check");
        if (filing.complete) summary.filed++;
        else summary.failed++;
      } else if (row.emailStatus === "SENT") {
        const r = await sendCourierReminder(row.tenantId, row.id, now);
        if (r.outcome === "sent") summary.reminded++;
        else if (r.outcome === "failed") summary.failed++;
      } else {
        const r = await sendCourierConfirmation(row.tenantId, row.id, { userName: "Daily check" });
        if (r.outcome === "sent") summary.sent++;
        else if (r.outcome === "failed") summary.failed++;
      }
    } catch (err) {
      summary.failed++;
      console.error(`[courier-confirm-job] Sheet ${row.id}:`, err);
    }
  }
  return summary;
}
