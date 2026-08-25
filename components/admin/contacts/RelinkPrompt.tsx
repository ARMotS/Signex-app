"use client";

/**
 * RelinkPrompt.tsx
 * Shown after contacts are added or imported, when doing so rescued deliveries
 * that were already signed but had nobody to email.
 *
 * Those deliveries are in the dispatcher's queue on the dashboard either way —
 * `emailRelinkedAt` keeps them there regardless of age. This prompt exists so
 * the admin does not have to know that: they added the missing customer, and
 * the confirmation that could not go out is offered right where they are.
 *
 * Nothing sends without a click. A contacts import can rescue weeks of backlog
 * at once, and a burst of confirmations for old deliveries is not something to
 * do to a customer list on the admin's behalf.
 */

import { useState } from "react";

interface Props {
  /** Stops that became sendable — from the `relinked` block on the API response. */
  stopIds: string[];
  /** Refresh the surrounding view once confirmations have gone out. */
  onSent?: () => void;
}

type Phase = "idle" | "sending" | "done";

export function RelinkPrompt({ stopIds, onSent }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [sent, setSent] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || stopIds.length === 0) return null;

  const n = stopIds.length;
  const plural = n !== 1;

  async function sendAll() {
    setPhase("sending");
    let ok = 0;
    // Sequential, matching the dashboard's Send all: these go through one SMTP
    // relay, and firing a whole backlog at once is how a depot gets throttled.
    for (const [i, stopId] of stopIds.entries()) {
      try {
        const res = await fetch(`/api/invoices/${stopId}/notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const json = await res.json();
        if (json.success) ok++;
      } catch {
        // Counted as not sent; it stays in the dispatcher's queue either way.
      }
      setProgress(i + 1);
    }
    setSent(ok);
    setPhase("done");
    onSent?.();
  }

  if (phase === "done") {
    const failed = n - sent;
    return (
      <div className="flex items-start gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
        <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <div className="text-sm">
          <p className="font-semibold text-emerald-800">
            {sent} confirmation{sent !== 1 ? "s" : ""} sent
          </p>
          {failed > 0 && (
            <p className="text-xs text-emerald-700 mt-0.5">
              {failed} could not be sent and {failed !== 1 ? "remain" : "remains"} in
              the email queue on the dashboard.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-amber-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
            <polyline points="22,6 12,13 2,6" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900">
            {n} signed deliver{plural ? "ies" : "y"} can now be emailed
          </p>
          <p className="text-xs text-amber-800 mt-1">
            {plural ? "These were" : "This was"} signed before the customer existed in
            Contacts, so the confirmation had nowhere to go.{" "}
            {plural ? "They are" : "It is"} now linked and ready to send.
          </p>

          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={sendAll}
              disabled={phase === "sending"}
              className="px-3 py-1.5 text-xs font-medium font-mono rounded-lg bg-amber-900 text-white hover:bg-amber-800 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
            >
              {phase === "sending"
                ? `Sending ${progress} of ${n}…`
                : `Send ${n} confirmation${plural ? "s" : ""}`}
            </button>
            {phase === "idle" && (
              <button
                onClick={() => setDismissed(true)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg text-amber-800 hover:bg-amber-100 transition-colors"
              >
                Not now
              </button>
            )}
          </div>

          {phase === "idle" && (
            <p className="text-xs text-amber-700 mt-2">
              Not now leaves {plural ? "them" : "it"} in the email queue on the
              dashboard.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
