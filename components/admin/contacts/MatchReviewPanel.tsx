"use client";

/**
 * MatchReviewPanel.tsx
 * Shows fuzzy match results for stop→contact linking.
 * Auto-matched stops are listed; review/no_match items need user confirmation.
 */

import type { MatchResult } from "@/lib/contact-matcher";

interface MatchReviewPanelProps {
  matches: MatchResult[];
  onConfirm: (confirmed: { stopId: string; contactId: string }[]) => void;
  onSkip: () => void;
}

export function MatchReviewPanel({ matches, onConfirm, onSkip }: MatchReviewPanelProps) {
  const autoMatched = matches.filter((m) => m.status === "auto");
  const needsReview = matches.filter((m) => m.status === "review" || m.status === "no_match");

  // Only render if there's anything to review
  if (needsReview.length === 0 && autoMatched.length === 0) return null;

  function handleConfirm() {
    const confirmed = matches
      .filter((m) => m.contactId)
      .map((m) => ({ stopId: m.stopId, contactId: m.contactId! }));
    onConfirm(confirmed);
  }

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-100">
        <h2 className="text-sm font-semibold font-mono text-zinc-900">Contact matching</h2>
        <div className="flex items-center gap-4 mt-1.5">
          {autoMatched.length > 0 && (
            <span className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-medium">
              {autoMatched.length} auto-matched
            </span>
          )}
          {needsReview.length > 0 && (
            <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full font-medium">
              {needsReview.length} need{needsReview.length === 1 ? "s" : ""} review
            </span>
          )}
        </div>
      </div>

      <div className="divide-y divide-zinc-100 max-h-80 overflow-y-auto">
        {/* Auto-matched (collapsed summary) */}
        {autoMatched.length > 0 && (
          <div className="px-5 py-3 bg-emerald-50/50">
            <p className="text-xs text-emerald-700 font-medium mb-2">
              ✓ Auto-matched ({autoMatched.length})
            </p>
            <div className="space-y-1">
              {autoMatched.map((m) => (
                <div key={m.stopId} className="flex items-center gap-2 text-xs text-zinc-600">
                  <span className="font-medium text-zinc-800 truncate max-w-[180px]">{m.customerName}</span>
                  <svg className="w-3 h-3 text-zinc-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                  <span className="truncate max-w-[180px] text-emerald-700">{m.matchedName}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Needs review */}
        {needsReview.map((m) => (
          <div key={m.stopId} className="px-5 py-3 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-zinc-800 truncate">{m.customerName}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <svg className="w-3 h-3 text-zinc-300 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
                {m.status === "review" && m.matchedName ? (
                  <>
                    <span className="text-xs text-zinc-600 truncate">{m.matchedName}</span>
                    <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded font-medium shrink-0">
                      Low confidence
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-red-600 bg-red-50 border border-red-200 px-1.5 py-0.5 rounded font-medium">
                    No match found
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="px-5 py-4 border-t border-zinc-100 flex gap-3">
        <button
          onClick={onSkip}
          className="flex-1 py-2 text-sm border border-zinc-200 rounded-lg text-zinc-600 hover:bg-zinc-50 transition-colors font-medium"
        >
          Skip
        </button>
        <button
          onClick={handleConfirm}
          className="flex-1 py-2 text-sm bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 transition-colors font-medium font-mono"
        >
          Confirm &amp; deploy
        </button>
      </div>
    </div>
  );
}
