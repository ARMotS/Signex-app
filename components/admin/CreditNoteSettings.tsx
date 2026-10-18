"use client";

import { useState } from "react";

/**
 * The VAT rate a credit note's VAT line is checked against when it is read.
 * Only a check on the note's own arithmetic — Signex never works VAT out for
 * anyone. Blank means the standard 15%.
 */
export default function CreditNoteSettings({
  savedRate,
  onSaved,
}: {
  savedRate: string;
  onSaved: (rate: string) => void;
}) {
  const [draft, setDraft] = useState(savedRate);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const hasChanges = draft.trim() !== savedRate.trim();

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vatRatePercent: draft.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        const saved = data.config?.vatRatePercent ?? draft.trim();
        setDraft(saved);
        onSaved(saved);
        setResult({ success: true, message: "Saved — new credit notes are checked against it" });
      } else {
        setResult({ success: false, message: data.error || "Failed to save" });
      }
    } catch {
      setResult({ success: false, message: "Network error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 bg-ink-card border border-ink-border rounded overflow-hidden">
      <div className="px-6 py-4 border-b border-ink-border">
        <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
          Credit Notes
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          Each credit note&apos;s VAT line is checked against this rate when it is read. Leave blank
          for 15%. The credits folder itself is chosen under OneDrive above.
        </p>
      </div>

      <div className="p-6 flex items-center gap-2">
        <label htmlFor="vat-rate" className="text-sm text-ink-black">VAT rate</label>
        <input
          id="vat-rate"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          inputMode="decimal"
          placeholder="15"
          className="w-20 px-3 py-2 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
        />
        <span className="text-sm text-ink-muted">%</span>
      </div>

      <div className="flex items-center justify-between px-6 py-4 border-t border-ink-border bg-ink-surface/50">
        <div className="flex-1">
          {result && (
            <div className={`text-sm font-mono ${result.success ? "text-ink-green" : "text-ink-red"}`}>
              {result.success ? "✓" : "✕"} {result.message}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {hasChanges && (
            <button
              onClick={() => setDraft(savedRate)}
              className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={save}
            disabled={!hasChanges || saving}
            className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
              hasChanges && !saving
                ? "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
                : "bg-ink-border text-ink-muted cursor-not-allowed"
            }`}
          >
            {saving ? "Saving…" : "Save Rate"}
          </button>
        </div>
      </div>
    </div>
  );
}
