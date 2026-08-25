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

// ─── Back-fill links for contacts added after the fact ───────────────────────

export interface RelinkSummary {
  /** Stops that gained a contact they did not have before. */
  linked: number;
  /**
   * Of those, signed deliveries whose confirmation had nowhere to go and can
   * now be emailed. This is the number worth putting in front of the admin.
   */
  nowSendable: number;
  /** Stop ids behind `nowSendable`, so the caller can offer to send them. */
  sendableStopIds: string[];
}

/**
 * Re-match every unlinked stop in one scope against the current contact list.
 *
 * `Stop.contactId` used to be written once, when a trip sheet was deployed. A
 * customer who was not yet in Contacts left the stop unlinked permanently, and
 * because the send path resolves the recipient through `Stop.contact`, the
 * delivery was unreachable: it showed as "no address on file", and pressing Send
 * simply re-marked it NO_EMAIL. Adding the contact — by hand or by import — now
 * repairs the link.
 *
 * PENDING stops are re-linked too, not just signed ones, so a delivery signed
 * later today finds its contact without anyone intervening.
 *
 * Only `auto` matches are applied — the same score threshold the deploy-time
 * matcher trusts without review. The stakes justify the caution: the
 * confirmation carries the signed invoice as an attachment, so a wrong link
 * would mail one company another company's paperwork. Weaker "review" candidates
 * are deliberately left alone rather than guessed at.
 */
export async function relinkUnmatchedStops(tenantId: string): Promise<RelinkSummary> {
  const db = scopedPrisma(tenantId);
  const empty: RelinkSummary = { linked: 0, nowSendable: 0, sendableStopIds: [] };

  const orphans = await db.stop.findMany({
    where: { contactId: null },
    select: { id: true, customerName: true, status: true, emailStatus: true },
  });
  if (orphans.length === 0) return empty;

  const matches = await matchStopsToContacts(tenantId, orphans);
  const auto = matches.filter(
    (m): m is MatchResult & { contactId: string } =>
      m.status === "auto" && !!m.contactId
  );
  if (auto.length === 0) return empty;

  const { applied } = await applyContactMatches(
    tenantId,
    auto.map((m) => ({ stopId: m.stopId, contactId: m.contactId }))
  );
  if (applied === 0) return empty;

  // Which of the freshly linked stops are signed deliveries that can now
  // actually be emailed? Only a contact carrying an address changes anything.
  const contactsWithEmail = new Set(
    (
      await db.contact.findMany({
        where: {
          id: { in: [...new Set(auto.map((m) => m.contactId))] },
          email: { not: null },
          deletedAt: null,
        },
        select: { id: true },
      })
    ).map((c) => c.id)
  );

  const orphanById = new Map(orphans.map((o) => [o.id, o]));
  const sendableStopIds = auto
    .filter((m) => {
      const stop = orphanById.get(m.stopId);
      return (
        stop?.status === "SIGNED" &&
        // NOT_SENT is included because a stop can be unlinked and untried at
        // once — the automatic send on signature marks NO_EMAIL, but a stop
        // signed before confirmations existed never got that far.
        (stop.emailStatus === "NO_EMAIL" || stop.emailStatus === "NOT_SENT") &&
        contactsWithEmail.has(m.contactId)
      );
    })
    .map((m) => m.stopId);

  if (sendableStopIds.length > 0) {
    // NO_EMAIL was a statement about the world, and the world changed. Moving
    // back to NOT_SENT makes the stop a live retry candidate again; stamping
    // emailRelinkedAt is what keeps it visible past the queue's age bound.
    await db.stop.updateMany({
      where: { id: { in: sendableStopIds } },
      data: {
        emailStatus: "NOT_SENT",
        emailError: null,
        emailRelinkedAt: new Date(),
      },
    });
  }

  return { linked: applied, nowSendable: sendableStopIds.length, sendableStopIds };
}
