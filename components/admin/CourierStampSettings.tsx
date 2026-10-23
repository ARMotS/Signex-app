"use client";

/**
 * Where the courier handover is stamped on an invoice's last page. When text
 * is already printed in this area the stamp goes on an added page instead, so
 * this only needs to describe where the invoice usually has room.
 * See lib/courier-stamp.ts.
 */

import { useState } from "react";
import { DEFAULT_STAMP_AREA, readStampArea, type StampArea } from "@/lib/courier-stamp-text";

const FIELDS: { key: keyof StampArea; label: string }[] = [
  { key: "xPercent", label: "From left" },
  { key: "yPercent", label: "From bottom" },
  { key: "widthPercent", label: "Width" },
  { key: "heightPercent", label: "Height" },
];

export default function CourierStampSettings({
  savedArea,
  onSaved,
}: {
  savedArea: StampArea;
  onSaved: (area: StampArea) => void;
}) {
  const [draft, setDraft] = useState<StampArea>(savedArea);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const valid = readStampArea(draft);
  const changed = FIELDS.some((f) => draft[f.key] !== savedArea[f.key]);

  const save = async () => {
    if (!valid) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courierStampArea: valid }),
      });
      const data = await res.json();
      if (res.ok) {
        onSaved(valid);
        setResult({ ok: true, text: "Saved" });
      } else {
        setResult({ ok: false, text: data.error || "Failed to save" });
      }
    } catch {
      setResult({ ok: false, text: "Network error" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 bg-ink-card border border-ink-border rounded overflow-hidden">
      <div className="px-6 py-4 border-b border-ink-border">
        <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">Courier Signature Stamp</h2>
        <p className="text-xs text-ink-muted mt-1">
          Where the courier driver&apos;s signature and the dispatch details go on each invoice&apos;s last page. If
          anything is printed there, the stamp goes on a page added at the end instead — it never covers the invoice.
        </p>
      </div>

      <div className="p-6 flex flex-wrap gap-6 items-start">
        <div className="grid grid-cols-2 gap-3">
          {FIELDS.map((f) => (
            <label key={f.key} className="block">
              <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">{f.label} (%)</span>
              <input
                type="number"
                min={0}
                max={100}
                value={draft[f.key]}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: Number(e.target.value) }))}
                className="w-24 px-2 py-1.5 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
              />
            </label>
          ))}
        </div>

        {/* A sketch of the last page, A4 proportions. */}
        <div className="relative w-28 border border-ink-border bg-white" style={{ aspectRatio: "210 / 297" }} aria-hidden="true">
          {valid && (
            <div
              className="absolute bg-ink-green-dim border border-ink-green"
              style={{
                left: `${valid.xPercent}%`,
                bottom: `${valid.yPercent}%`,
                width: `${valid.widthPercent}%`,
                height: `${valid.heightPercent}%`,
              }}
            />
          )}
        </div>
        {!valid && (
          <p className="text-xs text-ink-red basis-full">
            The area must sit on the page and be at least 40% wide and 12% high.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between px-6 py-4 border-t border-ink-border bg-ink-surface/50">
        <div className="flex-1">
          {result && (
            <span className={`text-sm font-mono ${result.ok ? "text-ink-green" : "text-ink-red"}`}>
              {result.ok ? "✓" : "✕"} {result.text}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setDraft(DEFAULT_STAMP_AREA)} className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black">
            Reset to default
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!changed || !valid || saving}
            className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
              changed && valid && !saving ? "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]" : "bg-ink-border text-ink-muted cursor-not-allowed"
            }`}
          >
            {saving ? "Saving…" : "Save Stamp Area"}
          </button>
        </div>
      </div>
    </div>
  );
}
