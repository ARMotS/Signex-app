"use client";

import { useState } from "react";
import { DEFAULT_COLLECTION_DECLARATION } from "@/lib/collection-confirm";

/**
 * The wording printed above the customer's signature on every collection
 * receipt. Blank means the standard declaration. `{companyName}` is filled in
 * when the receipt is made.
 */
export default function CollectionDeclarationSettings({
  savedText,
  onSaved,
}: {
  savedText: string;
  onSaved: (text: string) => void;
}) {
  const [draft, setDraft] = useState(savedText);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const hasChanges = draft.trim() !== savedText.trim();

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionDeclarationText: draft.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        onSaved(draft.trim());
        setResult({ success: true, message: "Saved — used on receipts from now on" });
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
          Collection Receipt
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          The declaration the customer signs under when goods are collected. Leave blank for the
          standard wording. <span className="font-mono">{"{companyName}"}</span> is filled in.
        </p>
      </div>

      <div className="p-6">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={600}
          placeholder={DEFAULT_COLLECTION_DECLARATION}
          className="w-full px-3 py-2 text-sm bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green resize-y"
        />
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
              onClick={() => setDraft(savedText)}
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
            {saving ? "Saving…" : "Save Wording"}
          </button>
        </div>
      </div>
    </div>
  );
}
