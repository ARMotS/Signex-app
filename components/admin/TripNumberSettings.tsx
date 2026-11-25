"use client";

import { useMemo, useState } from "react";
import { BRANCH_CODE_MAX, exampleManualTripNumber, readBranchCode } from "@/lib/trip-number-format";

/**
 * Trip numbers: the branch code printed in the number of each trip built in
 * Signex (SX-P5-261125-01). Trip program sheets keep their own file names and
 * are never numbered. Blank means numbers carry no code (SX-261125-01).
 */
export default function TripNumberSettings({
  savedCode,
  onSaved,
}: {
  savedCode: string;
  onSaved: (branchCode: string) => void;
}) {
  const [code, setCode] = useState(savedCode);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const read = useMemo(() => readBranchCode(code), [code]);
  const hasChanges = (read.ok ? read.value : code.trim()) !== savedCode;
  const example = exampleManualTripNumber(read.ok ? read.value : savedCode);

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branchCode: code }),
      });
      const data = await res.json();
      if (res.ok) {
        const saved = String(data.config?.branchCode ?? (read.ok ? read.value : ""));
        setCode(saved);
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
          Trip Numbers
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          Trips built in Signex are numbered so they can never be mistaken for a Trip program sheet, which keeps
          its own file name. The branch code goes into each number. Changing it affects only numbers issued
          afterwards.
        </p>
      </div>

      <div className="p-6 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-2">
          <label htmlFor="branch-code" className="text-sm text-ink-black">Branch code</label>
          <input
            id="branch-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={BRANCH_CODE_MAX + 4}
            placeholder="P5"
            autoComplete="off"
            className="w-24 px-3 py-2 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
          />
        </div>
        <div className="text-sm text-ink-muted">
          Next trip today: <span className="font-mono text-ink-black">{example}</span>
        </div>
        {!read.ok && <div className="w-full text-xs text-ink-red">{read.error}</div>}
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
              onClick={() => setCode(savedCode)}
              className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={save}
            disabled={!hasChanges || !read.ok || saving}
            className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
              hasChanges && read.ok && !saving
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
