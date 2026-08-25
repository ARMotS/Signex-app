import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getAllTripSheets, getCompletedTripSheets } from "@/lib/trip-data";
import { dayWindow, parseTzOffset } from "@/lib/day-window";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * Everything the dispatcher's wallboard shows, in one round trip.
 *
 * DELIBERATELY DATABASE-ONLY. The dashboard is polled by the live-sync hook all
 * day and it used to build its headline numbers from `/api/invoices`, which
 * lists the whole invoice folder — over Microsoft Graph, for a OneDrive-backed
 * scope. Folder state belongs on the Invoices page, which is opened on purpose;
 * a wallboard left open in the corner of the office must not spend Graph quota
 * every few seconds. Every figure below comes from indexed columns.
 *
 * `?tzOffset=` puts the day boundary on the viewer's clock — see lib/day-window.
 */
/**
 * How far back an untried confirmation is still the dispatcher's problem.
 *
 * Confirmations only became automatic when this feature shipped, so every
 * delivery signed before that has emailStatus NOT_SENT — nobody ever tried,
 * because there was nothing to try. Without a bound the queue opens on day one
 * showing the entire history of the workspace, which is not a work list; it is
 * noise that buries the two deliveries that actually failed this morning.
 *
 * FAILED is deliberately NOT bounded (see the query below): the system tried
 * and could not deliver, and that must never quietly age out of view.
 */
const UNTRIED_QUEUE_DAYS = 7;

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);
  const day = dayWindow(new Date(), parseTzOffset(searchParams.get("tzOffset")));

  const untriedSince = new Date(Date.now() - UNTRIED_QUEUE_DAYS * 24 * 60 * 60 * 1000);

  /**
   * What counts as outstanding. SENDING is excluded — an attempt in flight is
   * not yet a problem, and offering a button for it only invites a duplicate.
   */
  const outstanding: Prisma.StopWhereInput = {
    status: "SIGNED",
    OR: [
      // Tried and rejected. Always actionable, however old.
      { emailStatus: "FAILED" },
      // Never tried, or no address on file — only while it is still this
      // week's work.
      {
        emailStatus: { in: ["NOT_SENT", "NO_EMAIL"] },
        signedAt: { gte: untriedSince },
      },
      // Rescued: the admin finally added the customer this delivery was waiting
      // on. Exempt from the age bound on purpose — the delivery only became
      // sendable just now, and the whole point of repairing the link is that
      // someone gets to act on it. Bounding by signedAt would silently discard
      // exactly the backlog the repair exists to recover.
      {
        emailStatus: { in: ["NOT_SENT", "NO_EMAIL"] },
        emailRelinkedAt: { not: null },
      },
    ],
  };

  const [
    tripSheets,
    completedToday,
    totalStops,
    signed,
    pending,
    inProgress,
    signedToday,
    emailCounts,
    sentCount,
    sendingCount,
    driverRoster,
    needsEmailRows,
    recentSignedRows,
  ] = await Promise.all([
    getAllTripSheets(ctx.tenantId),
    getCompletedTripSheets(ctx.tenantId, { since: day.start, until: day.end, limit: 200 }),
    ctx.db.stop.count(),
    ctx.db.stop.count({ where: { status: "SIGNED" } }),
    ctx.db.stop.count({ where: { status: "PENDING" } }),
    ctx.db.stop.count({ where: { status: "IN_PROGRESS" } }),
    ctx.db.stop.count({
      where: { status: "SIGNED", signedAt: { gte: day.start, lt: day.end } },
    }),
    // Counted over exactly the set the queue draws from, so the tiles above the
    // queue can never disagree with the rows inside it.
    ctx.db.stop.groupBy({ by: ["emailStatus"], where: outstanding, _count: true }),

    // Delivered confirmations, and attempts currently in flight. Counted apart
    // from the queue because neither is work for anyone.
    ctx.db.stop.count({ where: { emailStatus: "SENT" } }),
    ctx.db.stop.count({ where: { emailStatus: "SENDING" } }),
    // Every driver, not just the active ones: a stop signed this morning by an
    // account deactivated this afternoon still has to render with a name.
    ctx.db.driver.findMany({ select: { id: true, name: true, active: true } }),

    // The dispatcher's work queue: signed deliveries whose confirmation did not
    // go out by itself.
    ctx.db.stop.findMany({
      where: outstanding,
      orderBy: { signedAt: "desc" },
      take: 50,
      select: {
        id: true,
        invoiceNumber: true,
        customerName: true,
        signedAt: true,
        emailStatus: true,
        emailError: true,
        emailAttempts: true,
        emailRelinkedAt: true,
        contact: { select: { id: true, email: true, companyName: true } },
        tripSheet: { select: { driverId: true } },
      },
    }),

    ctx.db.stop.findMany({
      where: { status: "SIGNED", signedAt: { not: null } },
      orderBy: { signedAt: "desc" },
      take: 15,
      select: {
        id: true,
        invoiceNumber: true,
        customerName: true,
        signedAt: true,
        emailStatus: true,
        tripSheet: { select: { driverId: true } },
      },
    }),
  ]);

  const driverNames = new Map(driverRoster.map((d) => [d.id, d.name]));

  // ─── Per-driver progress ────────────────────────────────────────────────
  // A driver may hold several sheets at once, so this rolls them up per driver
  // rather than per sheet — the dispatcher asks "how is Sipho doing", not "how
  // is sheet 3 of 4 doing".
  const byDriver = new Map<
    string,
    {
      driverId: string;
      driverName: string;
      regNos: string[];
      sheets: number;
      total: number;
      signed: number;
      inProgress: number;
      pending: number;
      lastSignedAt: string | null;
    }
  >();

  for (const sheet of tripSheets) {
    const row = byDriver.get(sheet.driverId) ?? {
      driverId: sheet.driverId,
      driverName: sheet.driverName,
      regNos: [],
      sheets: 0,
      total: 0,
      signed: 0,
      inProgress: 0,
      pending: 0,
      lastSignedAt: null,
    };

    row.sheets += 1;
    if (sheet.regNo && !row.regNos.includes(sheet.regNo)) row.regNos.push(sheet.regNo);

    for (const stop of sheet.stops) {
      row.total += 1;
      if (stop.status === "SIGNED") {
        row.signed += 1;
        const at = stop.signedAt ? new Date(stop.signedAt).toISOString() : null;
        if (at && (!row.lastSignedAt || at > row.lastSignedAt)) row.lastSignedAt = at;
      } else if (stop.status === "IN_PROGRESS") {
        row.inProgress += 1;
      } else {
        row.pending += 1;
      }
    }

    byDriver.set(sheet.driverId, row);
  }

  const drivers = [...byDriver.values()].sort((a, b) => {
    // Still-working drivers first — those are the ones worth watching.
    const aDone = a.total > 0 && a.signed === a.total;
    const bDone = b.total > 0 && b.signed === b.total;
    if (aDone !== bDone) return aDone ? 1 : -1;
    return a.driverName.localeCompare(b.driverName);
  });

  // ─── Email queue ────────────────────────────────────────────────────────
  const emails = {
    sent: sentCount,
    sending: sendingCount,
    failed: 0,
    noEmail: 0,
    notSent: 0,
  };
  for (const row of emailCounts) {
    const n = typeof row._count === "number" ? row._count : 0;
    switch (row.emailStatus) {
      case "FAILED": emails.failed += n; break;
      case "NO_EMAIL": emails.noEmail += n; break;
      default: emails.notSent += n; break;
    }
  }

  const emailQueue = needsEmailRows.map((s) => ({
    stopId: s.id,
    invoiceNumber: s.invoiceNumber,
    customerName: s.customerName,
    driverName: driverNames.get(s.tripSheet?.driverId ?? "") ?? "Unknown",
    signedAt: s.signedAt?.toISOString() ?? null,
    emailStatus: s.emailStatus,
    emailError: s.emailError,
    emailAttempts: s.emailAttempts,
    /** Set when this delivery was rescued by a contact added after signing. */
    relinked: s.emailRelinkedAt !== null,
    contactId: s.contact?.id ?? null,
    recipient: s.contact?.email ?? null,
    /** False means "fix the contact first" — there is nowhere to send it. */
    sendable: !!s.contact?.email,
  }));

  // ─── Headline figures ───────────────────────────────────────────────────
  const remaining = pending + inProgress;
  const stopsDeliveredToday =
    signedToday + completedToday.reduce((sum, c) => sum + c.signedStops, 0);

  const signedTimes = tripSheets
    .flatMap((t) => t.stops)
    .map((s) => (s.signedAt ? new Date(s.signedAt).getTime() : 0))
    .filter((t) => t >= day.start.getTime() && t < day.end.getTime())
    .sort((a, b) => a - b);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    dayStart: day.start.toISOString(),
    dayEnd: day.end.toISOString(),

    stats: {
      totalStops,
      signed,
      pending,
      inProgress,
      remaining,
      completionPct: totalStops > 0 ? Math.round((signed / totalStops) * 100) : 0,
      /** Signed on live sheets today PLUS everything already closed out today. */
      stopsDeliveredToday,
      signedToday,
      activeSheets: tripSheets.length,
      completedSheetsToday: completedToday.length,
      driversOnRoad: drivers.filter((d) => d.signed < d.total).length,
      driversWithSheets: drivers.length,
      activeDrivers: driverRoster.filter((d) => d.active).length,
      firstSignedToday: signedTimes.length ? new Date(signedTimes[0]).toISOString() : null,
      lastSignedToday: signedTimes.length
        ? new Date(signedTimes[signedTimes.length - 1]).toISOString()
        : null,
    },

    emails: {
      ...emails,
      queue: emailQueue,
      needsAttention: emailQueue.length,
      /** So the UI can say what "not sent" is counted over. */
      untriedWindowDays: UNTRIED_QUEUE_DAYS,
    },
    drivers,
    tripSheets,
    completedToday,

    recentSignatures: recentSignedRows.map((s) => ({
      stopId: s.id,
      invoiceNumber: s.invoiceNumber,
      customerName: s.customerName,
      driverName: driverNames.get(s.tripSheet?.driverId ?? "") ?? "Unknown",
      signedAt: s.signedAt?.toISOString() ?? null,
      emailStatus: s.emailStatus,
    })),
  });
});
