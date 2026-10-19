"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DocChip, StatusBadge, collectionKind, collectionTone, creditNoteTone } from "@/components/ui/Chips";

/**
 * Everything in the invoice → collection → credit chain that someone in the
 * office has to act on, with counts. Each row links to where it is dealt with.
 */

interface Row {
  id: string;
  kind: "collection" | "credit_note";
  number: string | null;
  collectionType?: string;
  originalInvoiceNo?: string | null;
  invoiceNo?: string | null;
  customer: string | null;
  date: string | null;
  detail: string;
  href: string;
  status: string;
}

interface List {
  key: string;
  title: string;
  description: string;
  count: number;
  rows: Row[];
}

const formatDay = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export default function ExceptionsPage() {
  const [lists, setLists] = useState<List[] | null>(null);
  const [days, setDays] = useState(7);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const query = useCallback(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p;
  }, [from, to]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/exceptions?${query()}`)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(data.error || "Failed to load exceptions");
        else {
          setLists(data.lists);
          setDays(data.uncreditedDays);
          setError(null);
        }
      })
      .catch(() => !cancelled && setError("Network error"));
    return () => {
      cancelled = true;
    };
  }, [query]);

  const total = lists?.reduce((n, l) => n + l.count, 0) ?? 0;

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg font-medium text-ink-black">Exceptions</h1>
          <p className="text-sm text-ink-muted mt-1">
            Everything between invoice, collection and credit note that needs the office.
            {lists ? ` ${total} in all.` : ""}
          </p>
        </div>
        <a href={`/api/exceptions?${query()}&format=csv`} className="act">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export CSV
        </a>
      </div>

      <div className="bg-ink-card border border-ink-border rounded p-3 mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-ink-muted uppercase tracking-wide">From</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)}
            className="px-2 py-1.5 text-xs font-mono bg-ink-card border border-ink-border rounded focus:outline-none focus:border-ink-green" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-ink-muted uppercase tracking-wide">To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
            className="px-2 py-1.5 text-xs font-mono bg-ink-card border border-ink-border rounded focus:outline-none focus:border-ink-green" />
        </label>
        {(from || to) && (
          <button onClick={() => { setFrom(""); setTo(""); }} className="act">Clear dates</button>
        )}
        <p className="text-[11px] text-ink-muted ml-auto">
          &quot;Not credited&quot; means {days} days or more — change it in Settings → Credit Notes.
        </p>
      </div>

      {error && (
        <div className="bg-ink-red-dim border border-ink-red/20 rounded p-4 mb-4">
          <p className="text-sm font-mono text-ink-red">{error}</p>
        </div>
      )}
      {!lists && !error && (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-ink-muted">Looking for exceptions…</p>
        </div>
      )}

      {lists && (
        <div className="space-y-3">
          {lists.map((l) => {
            const isOpen = open[l.key] ?? l.count > 0;
            return (
              <div key={l.key} className="bg-ink-card border border-ink-border rounded overflow-hidden">
                <button
                  onClick={() => setOpen((o) => ({ ...o, [l.key]: !isOpen }))}
                  aria-expanded={isOpen}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink-surface/50 transition-colors"
                >
                  <StatusBadge tone={l.count > 0 ? "amber" : "idle"}>{l.count}</StatusBadge>
                  <span className="flex-1 min-w-0">
                    <span className="block font-mono text-sm text-ink-black">{l.title}</span>
                    <span className="block text-[11px] text-ink-muted">{l.description}</span>
                  </span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                    className={`text-ink-muted transition-transform shrink-0 ${isOpen ? "rotate-180" : ""}`}>
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {isOpen && l.count > 0 && (
                  <ul className="border-t border-ink-border divide-y divide-ink-border">
                    {l.rows.map((r) => (
                      <li key={r.id} className="px-4 py-2.5 flex items-center gap-2 flex-wrap text-[13px]">
                        {r.kind === "collection" ? (
                          <DocChip
                            kind={collectionKind({ type: r.collectionType ?? "CREDIT_RETURN", originalInvoiceNo: r.originalInvoiceNo })}
                            number={r.number ?? "—"}
                            tone={collectionTone(r.status)}
                          />
                        ) : (
                          <DocChip kind="CN" number={r.number ?? "—"} tone={creditNoteTone(r.status)} />
                        )}
                        {(r.originalInvoiceNo ?? r.invoiceNo) && (
                          <DocChip kind="INV" number={(r.originalInvoiceNo ?? r.invoiceNo)!} tone="ref" />
                        )}
                        <span className="text-ink-black truncate max-w-[16rem]">{r.customer ?? "—"}</span>
                        <span className="text-ink-muted font-mono text-[12px]">{formatDay(r.date)}</span>
                        <span className="text-ink-muted text-[12px]">· {r.detail}</span>
                        <Link href={r.href} className="act ml-auto">
                          Open
                        </Link>
                      </li>
                    ))}
                    {l.count > l.rows.length && (
                      <li className="px-4 py-2 text-[11px] text-ink-muted">
                        Showing the first {l.rows.length} of {l.count} — the CSV has the rest.
                      </li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
