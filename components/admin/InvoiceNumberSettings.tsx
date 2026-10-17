"use client";

import { useMemo, useState } from "react";
import { compileInvoiceNoPattern, normalizeInvoiceNo } from "@/lib/invoice-number";

/**
 * How this scope reads invoice numbers: the built-in rule, or a custom pattern.
 *
 * The preview runs lib/invoice-number.ts in the browser — the same function the
 * server matches with — so what the dispatcher sees here is what an import will
 * do. Saving re-reads every live stop and collection under the new pattern.
 */

const DEFAULT_SAMPLES = ["INV-2026-1047", "1047", "IV-1047-2026", "inv 1047"].join("\n");

export default function InvoiceNumberSettings({
  savedPattern,
  onSaved,
}: {
  savedPattern: string;
  onSaved: (pattern: string) => void;
}) {
  const [draft, setDraft] = useState(savedPattern);
  const [samples, setSamples] = useState(DEFAULT_SAMPLES);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const compiled = useMemo(() => compileInvoiceNoPattern(draft), [draft]);
  const pattern = compiled.ok ? compiled.pattern : null;
  const hasChanges = draft.trim() !== savedPattern.trim();

  const preview = samples
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((sample) => ({ sample, normalized: normalizeInvoiceNo(sample, pattern) }));

  const save = async () => {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceNoPattern: draft.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        onSaved(draft.trim());
        const r = data.renormalized as { stops: number; collections: number } | undefined;
        setResult({
          success: true,
          message: r
            ? `Saved — re-read ${r.stops} live ${r.stops === 1 ? "stop" : "stops"} and ${r.collections} ${
                r.collections === 1 ? "collection" : "collections"
              }`
            : "Saved",
        });
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
          Invoice Numbers
        </h2>
        <p className="text-xs text-ink-muted mt-1">
          How an invoice number is read so the PDF (INV-2026-1047), the trip sheet, the collection
          sheet and the credit note (1047) all match. Leave blank for the built-in rule.
        </p>
      </div>

      <div className="p-6 space-y-5">
        <div>
          <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-2">
            Custom pattern
          </label>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Built-in rule — e.g. ^INV-\d{4}-(\d+)$"
            spellCheck={false}
            className="w-full px-3 py-2 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
          />
          {!compiled.ok ? (
            <p className="text-xs text-ink-red mt-2">{compiled.error}</p>
          ) : (
            <p className="text-xs text-ink-muted mt-2">
              A regular expression with brackets around the number. Where it does not match, the
              built-in rule is used, so the bare 1047 on a sheet still works.
            </p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-2">
              Try it — one per line
            </label>
            <textarea
              value={samples}
              onChange={(e) => setSamples(e.target.value)}
              rows={5}
              spellCheck={false}
              className="w-full px-3 py-2 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
            />
          </div>
          <div>
            <span className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-2">
              Matched as
            </span>
            <ul className="text-sm font-mono space-y-1">
              {preview.map(({ sample, normalized }, i) => (
                <li key={`${i}-${sample}`} className="flex items-center gap-2 min-w-0">
                  <span className="text-ink-muted truncate">{sample}</span>
                  <span className="text-ink-muted shrink-0">→</span>
                  <strong className={normalized ? "text-ink-black" : "text-ink-red"}>
                    {normalized || "no number"}
                  </strong>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between px-6 py-4 border-t border-ink-border bg-ink-surface/50">
        <div className="flex-1">
          {result && (
            <div
              className={`text-sm font-mono animate-fade-in ${
                result.success ? "text-ink-green" : "text-ink-red"
              }`}
            >
              {result.success ? "✓" : "✕"} {result.message}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {hasChanges && (
            <button
              onClick={() => setDraft(savedPattern)}
              className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            onClick={save}
            disabled={!hasChanges || !compiled.ok || saving}
            className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
              hasChanges && compiled.ok && !saving
                ? "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
                : "bg-ink-border text-ink-muted cursor-not-allowed"
            }`}
          >
            {saving ? "Saving…" : "Save Pattern"}
          </button>
        </div>
      </div>
    </div>
  );
}
