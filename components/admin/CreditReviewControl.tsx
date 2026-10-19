"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { StatusBadge } from "@/components/ui/Chips";
import { CREDIT_REJECT_REASONS } from "@/lib/collection-confirm";

/**
 * The dispatcher's decision on a credit return that came back: approve it for
 * credit, or reject it (reason required). Until every such collection on a
 * trip is decided, the trip cannot be completed. The decision can be changed
 * while the trip is live.
 */
export default function CreditReviewControl({
  collection,
  onChanged,
}: {
  collection: {
    id: string;
    collectionNo: string;
    creditReview?: "APPROVED" | "REJECTED" | null;
    creditReviewReason?: string | null;
    creditReviewedBy?: string | null;
  };
  onChanged: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "APPROVE" | "REJECT") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/collections/${collection.id}/review`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, reason: decision === "REJECT" ? reason.trim() : undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "That did not work");
        return;
      }
      setRejecting(false);
      setChanging(false);
      setReason("");
      onChanged();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  const decided = collection.creditReview;
  const by = collection.creditReviewedBy ? ` by ${collection.creditReviewedBy}` : "";

  return (
    <>
      {decided === "APPROVED" && (
        <StatusBadge tone="green" dot title={`Approved for credit${by}`}>
          Approved for credit
        </StatusBadge>
      )}
      {decided === "REJECTED" && (
        <StatusBadge
          tone="red"
          dot
          title={`Rejected for credit${by}${collection.creditReviewReason ? ` — ${collection.creditReviewReason}` : ""}`}
        >
          Rejected for credit
        </StatusBadge>
      )}
      {!decided && (
        <StatusBadge tone="amber" dot title="The trip cannot be completed until this is approved or rejected">
          Awaiting approval
        </StatusBadge>
      )}

      {(!decided || changing) && (
        <>
          {decided !== "APPROVED" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                decide("APPROVE");
              }}
              disabled={busy}
              className="act act-green"
              title="The goods are fine — clear this collection for credit"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              Approve
            </button>
          )}
          {decided !== "REJECTED" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setRejecting(true);
              }}
              disabled={busy}
              className="act act-danger"
              title="Not creditable — kept on record, never matched to a credit note"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
              Reject…
            </button>
          )}
          {changing && (
            <button onClick={(e) => { e.stopPropagation(); setChanging(false); }} className="act">
              Cancel
            </button>
          )}
        </>
      )}
      {decided && !changing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setChanging(true);
          }}
          className="act"
          title="Change the decision — allowed until the trip is completed"
        >
          Change
        </button>
      )}
      {error && <span className="text-[11px] font-mono text-[color:var(--tone-red-fg)]">{error}</span>}

      {/* On the page body, not inside the trip card — see CollectionSheetPanel. */}
      {rejecting &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
            onClick={(e) => {
              e.stopPropagation();
              if (!busy) setRejecting(false);
            }}
          >
            <div
              className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-5 space-y-4">
                <div>
                  <h3 className="font-mono text-sm font-medium text-ink-black">
                    Reject collection {collection.collectionNo} for credit
                  </h3>
                  <p className="text-xs text-ink-muted mt-1">
                    It stays on record with its signed receipt, but no credit note is matched to it. If one
                    arrives, the Credits page flags it.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {CREDIT_REJECT_REASONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setReason(r)}
                      className={`act ${reason === r ? "!bg-ink-black !text-white !border-ink-black" : ""}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  maxLength={600}
                  placeholder="Why it is not creditable (required)"
                  className="w-full px-3 py-2 text-sm border border-ink-border rounded focus:outline-none focus:border-ink-black resize-none"
                />
                {error && <p className="text-xs text-ink-red">{error}</p>}
              </div>
              <div className="flex justify-end gap-2 px-6 py-4 border-t border-ink-border bg-ink-surface/50">
                <button onClick={() => setRejecting(false)} disabled={busy} className="act">
                  Cancel
                </button>
                <button
                  onClick={() => decide("REJECT")}
                  disabled={busy || reason.trim().length < 3}
                  className="act act-red"
                >
                  {busy ? "Rejecting…" : "Reject for credit"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
