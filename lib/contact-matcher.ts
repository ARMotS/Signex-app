/**
 * contact-matcher.ts
 * Fuzzy-matches trip sheet stops to existing contacts using Fuse.js.
 * Returns per-stop match results with confidence status for review UI.
 */

import Fuse from "fuse.js";
import { scopedPrisma } from "@/lib/db-scoped";

export interface MatchResult {
  stopId: string;
  customerName: string;
  contactId?: string;
  matchedName?: string;
  score?: number;
  status: "auto" | "review" | "no_match";
}

// ─── Match stops to contacts ──────────────────────────────────────────────────

/**
 * Fuzzy-match stops to contacts WITHIN one scope.
 *
 * The candidate pool is scoped, so the match-review UI can never surface another
 * ADMIN's company names — including as a near-miss suggestion.
 */
export async function matchStopsToContacts(
  tenantId: string,
  stops: { id: string; customerName: string }[]
): Promise<MatchResult[]> {
  const contacts = await scopedPrisma(tenantId).contact.findMany({
    where: { deletedAt: null },
    select: { id: true, companyName: true },
  });

  if (contacts.length === 0) {
    return stops.map((s) => ({
      stopId: s.id,
      customerName: s.customerName,
      status: "no_match",
    }));
  }

  const fuse = new Fuse(contacts, {
    keys: ["companyName"],
    threshold: 0.4,
    includeScore: true,
  });

  return stops.map((stop) => {
    const results = fuse.search(stop.customerName);

    if (results.length === 0) {
      return { stopId: stop.id, customerName: stop.customerName, status: "no_match" };
    }

    const best = results[0];
    // Fuse score: 0 = perfect match, 1 = no match
    const score = best.score ?? 1;

    let status: MatchResult["status"];
    if (score < 0.1) {
      status = "auto";
    } else if (score < 0.3) {
      status = "review";
    } else {
      status = "no_match";
    }

    return {
      stopId: stop.id,
      customerName: stop.customerName,
      contactId: best.item.id,
      matchedName: best.item.companyName,
      score,
      status,
    };
  });
}

// ─── Apply confirmed matches ──────────────────────────────────────────────────

/**
 * Apply confirmed matches within one scope.
 *
 * Both the stop and the contact must belong to `tenantId`. A foreign stop id is
 * a no-op (scoped updateMany matches zero rows); a foreign contact id is
 * additionally rejected by the composite foreign key on Stop.
 */
export async function applyContactMatches(
  tenantId: string,
  matches: { stopId: string; contactId: string }[]
): Promise<{ applied: number }> {
  if (matches.length === 0) return { applied: 0 };

  const db = scopedPrisma(tenantId);

  // Verify every contact is in scope up front, so one bad id fails the whole
  // batch loudly instead of tripping an FK violation mid-transaction.
  const contactIds = [...new Set(matches.map((m) => m.contactId))];
  const inScope = await db.contact.findMany({
    where: { id: { in: contactIds }, deletedAt: null },
    select: { id: true },
  });
  const valid = new Set(inScope.map((c) => c.id));
  const applicable = matches.filter((m) => valid.has(m.contactId));

  const results = await db.$transaction(
    applicable.map(({ stopId, contactId }) =>
      // updateMany, not update: a stop id from another scope matches nothing and
      // returns count 0 rather than throwing.
      db.stop.updateMany({
        where: { id: stopId },
        data: { contactId },
      })
    )
  );

  return { applied: results.reduce((sum, r) => sum + r.count, 0) };
}
