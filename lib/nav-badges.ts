/**
 * nav-badges.ts
 * The office sidebar's badges: how much is still open on each page. Every
 * badge is the count of that page's ACTIVE tab, so the badge and the page
 * always agree and a row leaves the badge the moment it leaves the tab:
 *
 *   - Trip Sheet:  live trip sheets (completing one archives it).
 *   - Courier:     sheets not yet signed for by the courier — needs attention
 *                  or awaiting collection. Signing completes a sheet.
 *   - Collections: pending collections on a live run, plus credit returns
 *                  that came back and still await approve / reject
 *                  (collectionLifecycle, lib/collection-confirm.ts).
 *   - Credits:     credit notes not yet signed or rejected (ready to sign or
 *                  needing review).
 *
 * Carried on /api/sync — every office tab already polls it, so the badges
 * cost four indexed counts per poll and no request of their own. Scoped: a
 * badge counts only the caller's own scope, like everything on that poll.
 */

import { scopedPrisma } from "./db-scoped";
import { COURIER_ACTIVE_STATUSES } from "./courier-sheet";

export interface NavBadges {
  tripSheets: number;
  courier: number;
  collections: number;
  credits: number;
}

export async function navBadges(tenantId: string): Promise<NavBadges> {
  const db = scopedPrisma(tenantId);
  const [tripSheets, courier, collections, credits] = await Promise.all([
    db.tripSheet.count(),
    db.courierTripSheet.count({ where: { status: { in: [...COURIER_ACTIVE_STATUSES] } } }),
    db.collection.count({
      where: {
        OR: [
          { status: "PENDING", tripSheetId: { not: null } },
          // awaitingCreditReview, as a query.
          {
            type: "CREDIT_RETURN",
            status: { in: ["COLLECTED", "PARTIAL"] },
            creditReview: null,
            AND: [{ originalInvoiceNo: { not: null } }, { originalInvoiceNo: { not: "" } }],
          },
        ],
      },
    }),
    db.creditNote.count({ where: { status: { in: ["RECEIVED", "NEEDS_REVIEW"] } } }),
  ]);
  return { tripSheets, courier, collections, credits };
}
