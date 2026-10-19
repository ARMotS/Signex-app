"use client";

import { useState } from "react";

/**
 * Credit note settings:
 *   - the VAT rate a credit note's VAT line is checked against when it is
 *     read (a check on the note's own arithmetic — Signex never works VAT out
 *     for anyone). Blank means the standard 15%.
 *   - how many days a credit return may sit collected with no signed credit
 *     note before the Exceptions screen lists it. Blank means 7.
 */
export default function CreditNoteSettings({
  savedRate,
  savedDays,
  onSaved,
}: {
  savedRate: string;
  savedDays: string;
  onSaved: (saved: { vatRatePercent: string; uncreditedAlertDays: string }) => void;
}) {
  const [rate, setRate] = useState(savedRate);
  const [days, setDays] = useState(savedDays);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const hasChanges = rate.trim() !== savedRate.trim() || days.trim() !== savedDays.trim();

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vatRatePercent: rate.trim(), uncreditedAlertDays: days.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        const saved = {
          vatRatePercent: data.config?.vatRatePercent ?? rate.trim(),
          uncreditedAlertDays: data.config?.uncreditedAlertDays ?? days.trim(),
        };
        setRate(saved.vatRatePercent);
        setDays(saved.uncreditedAlertDays);
        onSaved(saved);
        setResult({ success: true, message: "Saved" });
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
          Each credit note&apos;s VAT line is checked against the VAT rate when it is read. A credit return that
          has waited longer than the days below with no signed credit note is listed on Exceptions. The credits
          folder itself is chosen under OneDrive above.
        </p>
      </div>

      <div className="p-6 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-2">
          <label htmlFor="vat-rate" className="text-sm text-ink-black">VAT rate</label>
          <input
            id="vat-rate"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            inputMode="decimal"
            placeholder="15"
            className="w-20 px-3 py-2 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
          />
          <span className="text-sm text-ink-muted">%</span>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="uncredited-days" className="text-sm text-ink-black">Not credited after</label>
          <input
            id="uncredited-days"
            value={days}
            onChange={(e) => setDays(e.target.value)}
            inputMode="numeric"
            placeholder="7"
            className="w-20 px-3 py-2 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
          />
          <span className="text-sm text-ink-muted">days</span>
        </div>
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
              onClick={() => {
                setRate(savedRate);
                setDays(savedDays);
              }}
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
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
