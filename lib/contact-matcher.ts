/**
 * contact-matcher.ts
 * Fuzzy-matches trip sheet stops to existing contacts using Fuse.js.
 * Returns per-stop match results with confidence status for review UI.
 */

import Fuse from "fuse.js";
import { prisma } from "@/lib/db";

export interface MatchResult {
  stopId: string;
  customerName: string;
  contactId?: string;
  matchedName?: string;
  score?: number;
  status: "auto" | "review" | "no_match";
}

// ─── Match stops to contacts ──────────────────────────────────────────────────

export async function matchStopsToContacts(
  stops: { id: string; customerName: string }[]
): Promise<MatchResult[]> {
  const contacts = await prisma.contact.findMany({
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

export async function applyContactMatches(
  matches: { stopId: string; contactId: string }[]
): Promise<void> {
  await prisma.$transaction(
    matches.map(({ stopId, contactId }) =>
      prisma.stop.update({
        where: { id: stopId },
        data: { contactId },
      })
    )
  );
}
