"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { DocChip, StatusBadge, collectionKind, collectionTone, creditNoteTone, type Tone } from "@/components/ui/Chips";

/**
 * One invoice's chain: its delivery, the collections credited against it,
 * the credit notes that paid for them, and what is still outstanding per item.
 * Reached from the Invoices tab, and from any collection or credit note.
 */

interface Chain {
  invoice: { id: string; invoiceNo: string; invoiceDate: string | null; customerName: string | null; pdfFilename: string | null; isStub: boolean };
  status: string;
  statusLabel: string;
  deliveries: {
    live: boolean;
    driverName: string | null;
    tripDate: string | null;
    sourceFilename: string | null;
    stopNumber: number;
    signed: boolean;
    signedAt: string | null;
    signedByName: string | null;
    invoiceFile: string | null;
  }[];
  collections: {
    id: string;
    collectionNo: string;
    type: string;
    originalInvoiceNo: string | null;
    status: string;
    collectedAt: string | null;
    expectedQty: number | null;
    collectedQty: number | null;
    hasVariance: boolean;
    exceptionReason: string | null;
    creditReview: "APPROVED" | "REJECTED" | null;
    creditReviewReason: string | null;
    live: boolean;
    signedFilePath: string | null;
    sourceFilePath: string | null;
    itemsListed: number;
    itemsCollected: number;
    hasLines: boolean;
  }[];
  creditNotes: {
    id: string;
    creditNo: string | null;
    creditDate: string | null;
    total: number | null;
    status: string;
    signedAt: string | null;
    signedByName: string | null;
    signedFilename: string | null;
    collectionIds: string[];
    allocations: { collectionId: string; collectionNo: string; itemCode: string | null; qty: number }[];
  }[];
  balance: { item: string; description: string; collected: number; credited: number; outstanding: number }[];
}

const STATUS_TONE: Record<string, Tone> = {
  NOT_DELIVERED: "idle",
  DELIVERED: "green",
  COLLECTION_PENDING: "amber",
  AWAITING_CREDIT: "violet",
  PARTIALLY_CREDITED: "amber",
  FULLY_CREDITED: "blue",
  EXCEPTION: "red",
};

const COLLECTION_LABEL: Record<string, string> = {
  PENDING: "Pending",
  COLLECTED: "Collected",
  PARTIAL: "Partial",
  NOT_AVAILABLE: "Not available",
  REFUSED: "Refused",
};
const NOTE_LABEL: Record<string, string> = {
  RECEIVED: "Ready to sign",
  NEEDS_REVIEW: "Needs review",
  SIGNED: "Signed",
  REJECTED: "Rejected",
};

const formatDay = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-ZA", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const formatWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const money = (n: number | null) =>
  n === null ? "—" : `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DocIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);

/** One node of the tree: a label in the gutter, the content beside it. */
function Node({ label, children, last = false }: { label: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className="relative pl-6">
      {/* The tree's line: down to this node, and on to the next unless last. */}
      <span aria-hidden="true" className={`absolute left-2 top-0 w-px bg-ink-border ${last ? "h-5" : "h-full"}`} />
      <span aria-hidden="true" className="absolute left-2 top-5 w-3 h-px bg-ink-border" />
      <div className="py-2">
        <p className="text-[10px] font-mono text-ink-muted uppercase tracking-wide mb-1">{label}</p>
        {children}
      </div>
    </div>
  );
}

export default function InvoiceChainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/invoice-records/${id}`)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(data.error || "Failed to load the invoice");
        else setChain(data);
      })
      .catch(() => !cancelled && setError("Network error"));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="animate-fade-in">
        <Link href="/invoices" className="act mb-4">‹ Invoices</Link>
        <div className="bg-ink-red-dim border border-ink-red/20 rounded p-6 mt-4">
          <p className="text-sm font-mono text-ink-red">{error}</p>
        </div>
      </div>
    );
  }
  if (!chain) {
    return (
      <div className="bg-ink-card border border-ink-border rounded p-12 text-center animate-fade-in">
        <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm font-mono text-ink-muted">Loading the invoice chain…</p>
      </div>
    );
  }

  const { invoice } = chain;
  const notesFor = (collectionId: string) => chain.creditNotes.filter((n) => n.collectionIds.includes(collectionId));
  const unlinkedNotes = chain.creditNotes.filter((n) => n.collectionIds.length === 0);
  const totals = chain.balance.reduce(
    (t, r) => ({ collected: t.collected + r.collected, credited: t.credited + r.credited, outstanding: t.outstanding + r.outstanding }),
    { collected: 0, credited: 0, outstanding: 0 }
  );
  const nodes: { label: string; body: React.ReactNode }[] = [];

  // ── Delivery ──
  nodes.push({
    label: "Delivered",
    body:
      chain.deliveries.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {invoice.isStub ? "Signex has no PDF of this invoice and no delivery of it on record." : "No delivery of this invoice on record."}
        </p>
      ) : (
        <div className="space-y-1.5">
          {chain.deliveries.map((d, i) => (
            <div key={i} className="flex items-center gap-2 flex-wrap text-[13px]">
              <StatusBadge tone={d.signed ? "green" : "amber"} dot>
                {d.signed ? "Signed" : "On a live run"}
              </StatusBadge>
              <span className="text-ink-black">{d.driverName ?? "—"}</span>
              <span className="text-ink-muted font-mono text-[12px]">
                {formatDay(d.tripDate)} · stop {d.stopNumber}
                {d.signedAt ? ` · signed ${formatWhen(d.signedAt)}` : ""}
                {d.signedByName ? ` by ${d.signedByName}` : ""}
              </span>
              {d.signed && d.invoiceFile && (
                <a href={`/api/invoices/${encodeURIComponent(d.invoiceFile)}?signed=true`} target="_blank" rel="noreferrer" className="act ml-auto">
                  <DocIcon />
                  Signed invoice
                </a>
              )}
            </div>
          ))}
        </div>
      ),
  });

  // ── Collections, each with the credit notes that paid for it ──
  for (const c of chain.collections) {
    const notes = notesFor(c.id);
    nodes.push({
      label: "Collection",
      body: (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-[13px]">
            <DocChip kind={collectionKind(c)} number={c.collectionNo} tone={collectionTone(c.status)} />
            <StatusBadge tone={collectionTone(c.status)} dot>
              {COLLECTION_LABEL[c.status] ?? c.status}
            </StatusBadge>
            {c.creditReview && (
              <StatusBadge tone={c.creditReview === "APPROVED" ? "green" : "red"} title={c.creditReviewReason ?? undefined}>
                {c.creditReview === "APPROVED" ? "Approved for credit" : "Rejected for credit"}
              </StatusBadge>
            )}
            {c.hasVariance && <StatusBadge tone="amber">Not as listed</StatusBadge>}
            <span className="text-ink-muted font-mono text-[12px]">
              {c.hasLines
                ? `${c.itemsCollected} of ${c.itemsListed} items`
                : `${c.collectedQty ?? 0} of ${c.expectedQty ?? "—"} boxes`}
              {c.collectedAt ? ` · ${formatWhen(c.collectedAt)}` : ""}
            </span>
            <span className="ml-auto flex items-center gap-2 flex-wrap">
              {c.sourceFilePath && (
                <a
                  href={c.live ? `/api/collections/${c.id}/source` : `/api/collections/document/${encodeURIComponent(c.sourceFilePath)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="act"
                >
                  <DocIcon />
                  Office sheet
                </a>
              )}
              {c.signedFilePath && (
                <a href={`/api/collections/document/${encodeURIComponent(c.signedFilePath)}?signed=true`} target="_blank" rel="noreferrer" className="act">
                  <DocIcon />
                  Signed receipt
                </a>
              )}
            </span>
          </div>
          {c.exceptionReason && <p className="text-[12px] text-[color:var(--tone-amber-fg)]">{c.exceptionReason}</p>}
          {c.creditReview === "REJECTED" && c.creditReviewReason && (
            <p className="text-[12px] text-ink-muted">Rejected for credit: {c.creditReviewReason}</p>
          )}
          {/* The credit notes that paid for it, one level in. */}
          {notes.length > 0 && (
            <div className="border-l border-ink-border ml-1 pl-4 space-y-1.5">
              {notes.map((n) => (
                <CreditRow key={n.id} note={n} forCollection={c.id} />
              ))}
            </div>
          )}
        </div>
      ),
    });
  }

  // ── Credit notes no collection leads to ──
  if (unlinkedNotes.length > 0) {
    nodes.push({
      label: "Credit notes not tied to a collection",
      body: (
        <div className="space-y-1.5">
          {unlinkedNotes.map((n) => (
            <CreditRow key={n.id} note={n} />
          ))}
        </div>
      ),
    });
  }

  // ── Balance ──
  nodes.push({
    label: "Balance",
    body:
      chain.balance.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing has come back against this invoice.</p>
      ) : (
        <div className="border border-ink-border rounded overflow-x-auto bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-mono text-ink-muted uppercase tracking-wide border-b border-ink-border">
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2 hidden sm:table-cell">Description</th>
                <th className="px-3 py-2 text-right">Collected</th>
                <th className="px-3 py-2 text-right">Credited</th>
                <th className="px-3 py-2 text-right">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {chain.balance.map((r) => (
                <tr key={r.item + r.description} className="border-b border-ink-border last:border-0">
                  <td className="px-3 py-2 font-mono">{r.item}</td>
                  <td className="px-3 py-2 text-ink-muted hidden sm:table-cell">{r.description}</td>
                  <td className="px-3 py-2 font-mono text-right">{r.collected}</td>
                  <td className="px-3 py-2 font-mono text-right">{r.credited}</td>
                  <td className={`px-3 py-2 font-mono text-right ${r.outstanding > 0 ? "text-[color:var(--tone-amber-fg)] font-medium" : ""}`}>
                    {r.outstanding}
                  </td>
                </tr>
              ))}
              <tr className="bg-ink-surface/60 font-mono text-[12px]">
                <td className="px-3 py-2 text-ink-muted" colSpan={1}>Total</td>
                <td className="px-3 py-2 hidden sm:table-cell" />
                <td className="px-3 py-2 text-right">{totals.collected}</td>
                <td className="px-3 py-2 text-right">{totals.credited}</td>
                <td className="px-3 py-2 text-right">{totals.outstanding}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ),
  });

  return (
    <div className="animate-fade-in max-w-4xl">
      <Link href="/invoices" className="act mb-4">‹ Invoices</Link>

      {/* The invoice */}
      <div className="bg-ink-card border border-ink-border rounded p-4 sm:p-5 mt-3">
        <div className="flex items-center gap-2 flex-wrap">
          <DocChip kind="INV" number={invoice.invoiceNo} tone={STATUS_TONE[chain.status] === "idle" ? "idle" : "ref"} />
          <StatusBadge tone={STATUS_TONE[chain.status] ?? "idle"} dot>
            {chain.statusLabel}
          </StatusBadge>
          {invoice.isStub && <StatusBadge tone="amber" title="The invoice PDF was never received">No PDF on file</StatusBadge>}
          <span className="ml-auto flex items-center gap-2 flex-wrap">
            {invoice.pdfFilename && (
              <a href={`/api/invoices/${encodeURIComponent(invoice.pdfFilename)}`} target="_blank" rel="noreferrer" className="act">
                <DocIcon />
                Original
              </a>
            )}
          </span>
        </div>
        <p className="mt-2 text-sm text-ink-black">
          <span className="font-mono">{formatDay(invoice.invoiceDate)}</span>
          <span className="text-ink-muted"> · </span>
          {invoice.customerName ?? "—"}
        </p>
      </div>

      {/* The chain */}
      <div className="bg-ink-card border border-ink-border rounded px-3 sm:px-5 py-3 mt-3">
        {nodes.map((n, i) => (
          <Node key={i} label={n.label} last={i === nodes.length - 1}>
            {n.body}
          </Node>
        ))}
      </div>
    </div>
  );
}

function CreditRow({ note, forCollection }: { note: Chain["creditNotes"][number]; forCollection?: string }) {
  const items = note.allocations.filter((a) => !forCollection || a.collectionId === forCollection);
  return (
    <div className="flex items-center gap-2 flex-wrap text-[13px]">
      <span className="text-[10px] font-mono text-ink-muted uppercase tracking-wide">Credit</span>
      {note.creditNo ? (
        <DocChip kind="CN" number={note.creditNo} tone={creditNoteTone(note.status)} />
      ) : (
        <span className="font-mono text-ink-muted">Credit note</span>
      )}
      <StatusBadge tone={creditNoteTone(note.status)} dot>
        {NOTE_LABEL[note.status] ?? note.status}
      </StatusBadge>
      <span className="text-ink-muted font-mono text-[12px]">
        {formatDay(note.creditDate)} · {money(note.total)}
        {items.length > 0 ? ` · ${items.map((a) => `${a.qty} × ${a.itemCode ?? "item"}`).join(", ")}` : ""}
        {note.signedByName ? ` · signed by ${note.signedByName}` : ""}
      </span>
      <span className="ml-auto flex items-center gap-2">
        <Link href={`/credits?note=${note.id}`} className="act">
          Open
        </Link>
        <a href={`/api/credit-notes/${note.id}/document`} target="_blank" rel="noreferrer" className="act">
          <DocIcon />
          {note.status === "SIGNED" ? "Signed copy" : "PDF"}
        </a>
      </span>
    </div>
  );
}
