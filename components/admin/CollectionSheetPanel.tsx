"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The office's collection sheet for one collection, on the trip card: a badge
 * that says whether it has been read, and a panel with its lines, anything
 * that disagreed, and the office's three actions — attach a sheet by hand,
 * read it again, or approve one that needs review.
 *
 * The sheet is read automatically at deploy and re-checked while the trip has
 * not started; this is the fallback and the review, not the main path.
 */

export interface SheetLine {
  lineNo: number;
  itemCode: string | null;
  shortName: string | null;
  description: string;
  qtyListed: number;
  reasonCode: string | null;
  type: "CREDIT_RETURN" | "NON_CREDIT_UPLIFT";
  /** What the driver brought back, once recorded. */
  qtyCollected?: number | null;
  diffReason?: string | null;
  diffNote?: string | null;
  isExtra?: boolean;
}

export interface SheetCollection {
  id: string;
  collectionNo: string;
  status: string;
  sheetStatus?: "MISSING" | "READY" | "NEEDS_REVIEW";
  sheetIssues?: { code: string; level: "review" | "warning"; message: string }[] | null;
  /** Why the last attempt to read the sheet failed — shown, never swallowed. */
  sheetError?: string | null;
  lines?: SheetLine[];
}

const BADGE: Record<NonNullable<SheetCollection["sheetStatus"]>, { label: string; className: string }> = {
  READY: { label: "Sheet", className: "bg-ink-green-dim text-ink-green border-ink-green/20" },
  NEEDS_REVIEW: { label: "Sheet: review", className: "bg-ink-amber-dim text-ink-amber border-ink-amber/20" },
  MISSING: { label: "No sheet", className: "bg-ink-surface text-ink-muted border-ink-border" },
};

export default function CollectionSheetPanel({
  collection,
  onChanged,
}: {
  collection: SheetCollection;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const status = collection.sheetStatus ?? "MISSING";
  const lines = collection.lines ?? [];
  const issues = collection.sheetIssues ?? [];
  const editable = collection.status === "PENDING";
  // Once the driver has recorded the outcome, show what came back beside the sheet.
  const collected = !editable && lines.some((l) => l.qtyCollected != null);
  const badge = BADGE[status];

  const describe = (json: { status?: string; lines?: number; issues?: unknown[] }) =>
    `Read ${json.lines ?? 0} line${json.lines === 1 ? "" : "s"} — ${
      json.status === "NEEDS_REVIEW" ? "needs review" : "ready"
    }`;

  const attach = async (file: File, overwrite = false) => {
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (overwrite) form.append("overwrite", "true");
      const res = await fetch(`/api/collections/${collection.id}/sheet`, { method: "POST", body: form });
      const json = await res.json();
      if (res.status === 409 && json.conflict) {
        if (window.confirm(`${json.filename} is already in the collections folder. Replace it with this file?`)) {
          await attach(file, true);
        }
        return;
      }
      setMessage(res.ok ? { ok: true, text: describe(json) } : { ok: false, text: json.error || "Failed to attach" });
      if (res.ok) onChanged();
    } catch {
      setMessage({ ok: false, text: "Network error" });
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: "reread" | "approve") => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/collections/${collection.id}/sheet`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      setMessage(
        res.ok
          ? { ok: true, text: action === "approve" ? "Approved" : describe(json) }
          : { ok: false, text: json.error || "Failed" }
      );
      if (res.ok) onChanged();
    } catch {
      setMessage({ ok: false, text: "Network error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`font-mono text-[11px] px-1.5 py-0.5 rounded border ${badge.className}`}
        title={
          status === "MISSING"
            ? collection.sheetError
              ? `The sheet could not be read: ${collection.sheetError}`
              : "No collection sheet found yet — the driver collects against the box count"
            : `${lines.length} line(s) read from the office's sheet`
        }
      >
        {badge.label}
        {status !== "MISSING" && ` · ${lines.length}`}
      </button>

      {/* Rendered on the page body, not inside the trip card: the card's
          styles make a "fixed" overlay relative to the card instead of the
          screen, which clipped the dialog and hid its buttons. */}
      {open && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="shrink-0 px-6 py-4 border-b border-ink-border">
              <h3 className="font-mono text-sm font-medium text-ink-black">
                Collection sheet · {collection.collectionNo}
              </h3>
              <p className="text-xs text-ink-muted mt-1">
                {status === "MISSING"
                  ? "No sheet has been found in the collections folder yet. Until one is, the driver collects against the box count on the trip sheet."
                  : status === "NEEDS_REVIEW"
                  ? "Read, but something disagrees with the trip sheet. Check it, then approve or attach the right sheet."
                  : "Read and consistent with the trip sheet."}
              </p>
            </div>

            <div className="flex-1 min-h-0 px-6 py-4 overflow-y-auto space-y-4">
              {status === "MISSING" && collection.sheetError && (
                <p className="text-xs px-2.5 py-1.5 rounded border bg-ink-red-dim/40 text-ink-red border-ink-red/20">
                  Last attempt to read the sheet failed: {collection.sheetError}
                </p>
              )}
              {issues.length > 0 && (
                <ul className="space-y-1.5">
                  {issues.map((issue) => (
                    <li
                      key={issue.code}
                      className={`text-xs px-2.5 py-1.5 rounded border ${
                        issue.level === "review"
                          ? "bg-ink-amber-dim/50 text-ink-amber border-ink-amber/20"
                          : "bg-ink-surface text-ink-muted border-ink-border"
                      }`}
                    >
                      {issue.message}
                    </li>
                  ))}
                </ul>
              )}

              {lines.length > 0 && (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-ink-muted font-mono uppercase tracking-wide">
                      <th className="py-1 pr-2">#</th>
                      <th className="py-1 pr-2">Item</th>
                      <th className="py-1 pr-2">Description</th>
                      <th className="py-1 pr-2 text-right">Qty</th>
                      {collected && <th className="py-1 pr-2 text-right">Got</th>}
                      <th className="py-1 text-right">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-border">
                    {lines.map((line) => {
                      const differs =
                        line.isExtra || !!line.diffReason || (collected && (line.qtyCollected ?? 0) !== line.qtyListed);
                      return (
                        <tr key={line.lineNo} className={differs ? "bg-ink-amber-dim/30" : ""}>
                          <td className="py-1.5 pr-2 font-mono text-ink-muted">{line.lineNo}</td>
                          <td className="py-1.5 pr-2 font-mono text-ink-black">{line.itemCode ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-ink-black">
                            {line.description}
                            {line.isExtra && (
                              <span className="ml-1.5 text-[10px] font-mono text-ink-blue">EXTRA — NOT ON SHEET</span>
                            )}
                            {line.type === "NON_CREDIT_UPLIFT" && (
                              <span className="ml-1.5 text-[10px] font-mono text-ink-muted">UPLIFT</span>
                            )}
                            {line.diffReason && (
                              <span className="block text-[11px] text-ink-amber">
                                {line.diffReason.replace(/_/g, " ").toLowerCase()}
                                {line.diffNote ? ` — ${line.diffNote}` : ""}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 pr-2 text-right font-mono text-ink-black">
                            {line.isExtra ? "—" : line.qtyListed}
                          </td>
                          {collected && (
                            <td className="py-1.5 pr-2 text-right font-mono font-medium text-ink-black">
                              {line.qtyCollected ?? "—"}
                            </td>
                          )}
                          <td className="py-1.5 text-right font-mono text-ink-muted">{line.reasonCode ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}

              {message && (
                <p className={`text-xs font-mono ${message.ok ? "text-ink-green" : "text-ink-red"}`}>
                  {message.ok ? "✓" : "✕"} {message.text}
                </p>
              )}
            </div>

            <div className="shrink-0 flex flex-wrap justify-end gap-2 px-6 py-4 border-t border-ink-border bg-ink-surface/50">
              <a
                href={`/api/collections/${collection.id}/source`}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-2 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Open sheet
              </a>
              {editable && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) void attach(file);
                    }}
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    disabled={busy}
                    className="px-3 py-2 text-xs font-mono rounded border border-ink-border bg-white hover:bg-ink-surface disabled:opacity-60"
                  >
                    Attach collection sheet
                  </button>
                  {/* Also on "No sheet": it looks the sheet up in the folder first. */}
                  <button
                    onClick={() => act("reread")}
                    disabled={busy}
                    className="px-3 py-2 text-xs font-mono rounded border border-ink-border bg-white hover:bg-ink-surface disabled:opacity-60"
                  >
                    {status === "MISSING" ? "Look for sheet" : "Read again"}
                  </button>
                  {status === "NEEDS_REVIEW" && (
                    <button
                      onClick={() => act("approve")}
                      disabled={busy}
                      className="px-3 py-2 text-xs font-mono font-medium rounded bg-ink-green text-white hover:bg-ink-green-hover disabled:opacity-60"
                    >
                      Approve
                    </button>
                  )}
                </>
              )}
              <button
                onClick={() => setOpen(false)}
                className="px-3 py-2 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
