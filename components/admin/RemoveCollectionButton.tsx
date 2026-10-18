"use client";

import { useState } from "react";
import { createPortal } from "react-dom";

/**
 * Take a collection off a live run — the customer rang to say not to collect.
 *
 * Only offered while the collection is still pending: once the driver has
 * recorded an outcome, it is settled. A reason is required and kept, so the
 * trip card can say what came off and why. If the collection was all that
 * stop held, the stop comes off the driver's run with it.
 */

const QUICK_REASONS = [
  "Customer cancelled the collection",
  "Customer says there is nothing to collect",
  "Rebooked for another day",
];

export default function RemoveCollectionButton({
  collection,
  stopHasOtherWork,
  onRemoved,
}: {
  collection: { id: string; collectionNo: string; customerName: string };
  /** The stop also has a delivery or other collections, so it stays. */
  stopHasOtherWork: boolean;
  onRemoved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/collections/${collection.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Failed to remove the collection");
        return;
      }
      setOpen(false);
      setReason("");
      onRemoved();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="font-mono text-[11px] text-ink-muted hover:text-ink-red hover:underline"
        title="Take this collection off the run — the customer said not to collect"
      >
        Remove…
      </button>

      {/* Rendered on the page body, not inside the trip card: the card's
          styles make a "fixed" overlay relative to the card instead of the
          screen, which clipped the dialog and hid its buttons. */}
      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
          onClick={(e) => {
            e.stopPropagation();
            if (!saving) setOpen(false);
          }}
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5 space-y-4">
              <div>
                <h3 className="font-mono text-sm font-medium text-ink-black">
                  Remove collection {collection.collectionNo}
                </h3>
                <p className="text-xs text-ink-muted mt-1">
                  {collection.customerName} ·{" "}
                  {stopHasOtherWork
                    ? "The stop stays on the run for its other work."
                    : "Nothing else is at this stop, so it comes off the driver's run too."}
                </p>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {QUICK_REASONS.map((r) => (
                  <button
                    key={r}
                    onClick={() => setReason(r)}
                    className={`px-2 py-1 rounded text-[11px] font-mono border ${
                      reason === r ? "bg-ink-black text-white border-ink-black" : "bg-white text-ink-muted border-ink-border"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="Why it comes off the run (required)"
                className="w-full px-3 py-2 text-sm border border-ink-border rounded focus:outline-none focus:border-ink-black resize-none"
              />
              <p className="text-[11px] text-ink-muted">
                The driver&apos;s phone updates on its own. The office&apos;s collection sheet stays in the folder.
              </p>
              {error && <p className="text-xs text-ink-red">{error}</p>}
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-ink-border bg-ink-surface/50">
              <button
                onClick={() => setOpen(false)}
                disabled={saving}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={saving || reason.trim().length === 0}
                className="px-4 py-2 text-sm font-mono font-medium text-white bg-ink-red rounded hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Removing…" : "Remove from route"}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
