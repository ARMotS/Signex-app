/**
 * Which signed deliveries are the dispatcher's email work: the dashboard's
 * Emails queue, and the count the company admin's branch cards show. One
 * rule, so the two can never disagree.
 */

import type { Prisma } from "@prisma/client";

/**
 * How far back an untried confirmation is still the dispatcher's problem.
 *
 * Confirmations only became automatic when this feature shipped, so every
 * delivery signed before that has emailStatus NOT_SENT — nobody ever tried,
 * because there was nothing to try. Without a bound the queue opens on day one
 * showing the entire history of the workspace, which is not a work list; it is
 * noise that buries the two deliveries that actually failed this morning.
 *
 * FAILED is deliberately NOT bounded (see below): the system tried and could
 * not deliver, and that must never quietly age out of view.
 */
export const UNTRIED_QUEUE_DAYS = 7;

/**
 * What counts as outstanding. SENDING is excluded — an attempt in flight is
 * not yet a problem, and offering a button for it only invites a duplicate.
 */
export function outstandingEmailWhere(now = new Date()): Prisma.StopWhereInput {
  const untriedSince = new Date(now.getTime() - UNTRIED_QUEUE_DAYS * 24 * 60 * 60 * 1000);
  return {
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
}
