"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import SignaturePad, { type SignaturePadHandle } from "@/components/SignaturePad";
import { DocChip, StatusBadge as Badge, collectionKind, collectionTone, creditNoteTone } from "@/components/ui/Chips";
import RecordFilterBar, { Highlight, type FilterBarConfig } from "@/components/admin/RecordFilterBar";
import { usePagedRecords, useRecordFilters } from "@/hooks/useRecordFilters";

/**
 * Credit notes from the accounting software, read off the branch's credits
 * folder and matched to the invoice they credit and the collections whose
 * goods they pay for.
 *
 * The folder is looked at while this page is open (the list polls; the
 * server throttles the folder check per scope) and on "Check folder".
 * Signing off comes in a later step; this page is where a note is checked.
 */

type Status = "RECEIVED" | "NEEDS_REVIEW" | "SIGNED" | "REJECTED";

interface Issue {
  code: string;
  level: "review" | "warning";
  message: string;
}

interface CreditRow {
  id: string;
  creditNo: string | null;
  invoiceNo: string | null;
  creditDate: string | null;
  customerName: string | null;
  accountNo: string | null;
  total: number | null;
  status: Status;
  reviewCount: number;
  warningCount: number;
  collectionNos: string[];
  sourceFilename: string;
  sourceFolder: string;
  fileError: string | null;
  readSource: string | null;
  uploadedBy: string | null;
  signedByName: string | null;
  signedAt: string | null;
  filingError: string | null;
  receivedAt: string;
}

interface Folder {
  connected: boolean;
  path: string | null;
  checkedAt: string | null;
  error: string | null;
}

interface Allocation {
  collectionLineId: string;
  collectionNo: string;
  qty: number;
}

interface CreditDetail {
  id: string;
  creditNo: string | null;
  invoiceNo: string | null;
  creditDate: string | null;
  accountNo: string | null;
  deliverToName: string | null;
  billToName: string | null;
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
  status: Status;
  issues: Issue[];
  readSource: string | null;
  readAt: string | null;
  readError: string | null;
  rejectReason: string | null;
  sourceFilename: string;
  sourceFolder: string;
  fileError: string | null;
  uploadedBy: string | null;
  receivedAt: string;
  invoice: { id: string; invoiceNo: string; customerName: string | null; invoiceDate: string | null; pdfFilename: string | null; isStub: boolean } | null;
  lines: {
    lineNo: number;
    productCode: string | null;
    shortName: string | null;
    bin: string | null;
    description: string;
    qty: number;
    unitPrice: number | null;
    discountPct: number | null;
    nett: number | null;
    match: { status: "MATCHED" | "OVER" | "NOT_COLLECTED"; uncoveredQty: number; allocations: Allocation[] } | null;
  }[];
  collections: {
    linkId: string;
    source: "AUTO" | "MANUAL" | "EXCLUDED";
    linkedBy: string | null;
    id: string;
    collectionNo: string;
    originalInvoiceNo: string | null;
    status: string;
    customerName: string | null;
    collectedAt: string | null;
    hasVariance: boolean;
    lines: { id: string; lineNo: number; itemCode: string | null; description: string; qtyListed: number; qtyCollected: number | null; isExtra: boolean; type: string }[];
  }[];
  candidates: { id: string; collectionNo: string; originalInvoiceNo: string | null; customerName: string | null; collectedAt: string | null; status: string }[];
  signedByName: string | null;
  signedByLogin: string | null;
  signedAt: string | null;
  acknowledgedIssues: Issue[];
  acknowledgement: string | null;
  signedFilename: string | null;
  filedAt: string | null;
  filingError: string | null;
  originalRemoved: boolean;
  rejectedBy: string | null;
  rejectedAt: string | null;
  allocations: { lineNo: number; collectionNo: string; qty: number }[];
}

const STATUS_LABEL: Record<Status, string> = {
  RECEIVED: "Ready to sign",
  NEEDS_REVIEW: "Needs review",
  SIGNED: "Signed",
  REJECTED: "Rejected",
};

const TABS: { key: "" | Status; label: string }[] = [
  { key: "", label: "All" },
  { key: "NEEDS_REVIEW", label: "Needs review" },
  { key: "RECEIVED", label: "Ready to sign" },
  { key: "SIGNED", label: "Signed" },
  { key: "REJECTED", label: "Rejected" },
];

const money = (n: number | null) =>
  n === null ? "—" : `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatDate = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge tone={creditNoteTone(status)} dot>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

/** Poll every 30s while the tab is visible — that is also what keeps the folder looked at. */
const POLL_MS = 30_000;

interface PageExtra {
  counts: Record<Status, number>;
  folder: Folder;
  facets: { customers: string[] };
}

export default function CreditsPage() {
  const [filters, setFilters] = useRecordFilters("credits");
  const list = usePagedRecords<CreditRow, PageExtra>("/api/credit-notes", "creditNotes", filters);
  const rows = list.items;
  const counts = list.extra?.counts ?? null;
  const folder = list.extra?.folder ?? null;
  const { reload } = list;
  const load = reload;
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The tabs are the status filter's quick form: one status, or none.
  const tab: "" | Status = filters.status.length === 1 ? (filters.status[0] as Status) : "";

  // Polling is also what keeps the folder looked at (the server throttles it).
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [reload]);

  const barConfig: FilterBarConfig = {
    searchPlaceholder: "Credit no, invoice, customer, account, collection…",
    noun: "credit note",
    dateLabel: "Credit date",
    statusOptions: [],
    sortOptions: [
      { value: "date_desc", label: "Newest first" },
      { value: "date_asc", label: "Oldest first" },
      { value: "customer", label: "Customer A–Z" },
      { value: "number", label: "Credit no" },
      { value: "status", label: "Status" },
    ],
    customers: list.extra?.facets.customers,
    flagLabel: "Has warnings or issues",
  };

  // /credits?note=<id> (from an invoice's chain) opens that note. Read after
  // mount, so the server-rendered page and the first client render agree.
  useEffect(() => {
    const note = new URLSearchParams(window.location.search).get("note");
    if (!note) return;
    const t = setTimeout(() => setOpenId(note), 0);
    return () => clearTimeout(t);
  }, []);

  const flash = (ok: boolean, text: string) => {
    setMessage({ ok, text });
    setTimeout(() => setMessage(null), 6000);
  };

  const checkFolder = async () => {
    setChecking(true);
    try {
      const res = await fetch("/api/credit-notes/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok) flash(false, data.error || "The folder could not be checked");
      else if (data.outcome === "throttled") flash(true, "Checked a moment ago — try again in a few seconds.");
      else {
        const parts = [`${data.read} read`];
        if (data.duplicates) parts.push(`${data.duplicates} duplicate${data.duplicates === 1 ? "" : "s"} rejected`);
        if (data.waiting) parts.push(`${data.waiting} more on the next check`);
        flash(true, `Folder checked: ${data.inFolder} file${data.inFolder === 1 ? "" : "s"}, ${parts.join(", ")}.`);
      }
      load();
    } catch {
      flash(false, "Network error");
    } finally {
      setChecking(false);
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/credit-notes", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) flash(false, data.error || "Upload failed");
      else if (data.outcome === "duplicate") flash(false, "Uploaded, but that credit number was already received — moved to Rejected.");
      else {
        flash(true, `${file.name} uploaded and read.`);
        setOpenId(data.id);
      }
      load();
    } catch {
      flash(false, "Network error");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const waiting = counts ? counts.RECEIVED + counts.NEEDS_REVIEW : 0;

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-lg font-medium text-ink-black">Credits</h1>
          <p className="text-sm text-ink-muted mt-1">
            Credit notes from the accounting software, checked against the invoice and what the driver collected.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploading || !folder?.path}
            className="act"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {uploading ? "Uploading…" : "Upload credit note"}
          </button>
          <button
            onClick={checkFolder}
            disabled={checking || !folder?.path}
            className="act act-primary"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            {checking ? "Checking…" : "Check folder"}
          </button>
        </div>
      </div>

      {/* ── The folder ─────────────────────────────────────── */}
      {folder && (
        <div
          className={`mb-4 px-4 py-3 rounded border text-xs font-mono ${
            !folder.path || folder.error ? "bg-ink-amber-dim border-ink-amber/20 text-ink-black" : "bg-ink-card border-ink-border text-ink-muted"
          }`}
        >
          {!folder.connected ? (
            <>Connect OneDrive in Settings, then choose the credits folder the accounting software writes to.</>
          ) : !folder.path ? (
            <>No credits folder yet — choose one in Settings → OneDrive → Credits Folder.</>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>
                Folder: <span className="text-ink-black">{folder.path}</span>
              </span>
              <span>Last checked: {ago(folder.checkedAt)}</span>
              {folder.error && <span className="text-ink-red">Could not be read: {folder.error}</span>}
            </div>
          )}
        </div>
      )}

      {message && (
        <div className={`mb-4 px-4 py-2 rounded text-sm font-mono ${message.ok ? "bg-ink-green-dim text-ink-green" : "bg-ink-red-dim text-ink-red"}`}>
          {message.text}
        </div>
      )}

      {/* ── Summary ─────────────────────────────────────────── */}
      {counts && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            { label: "Waiting to sign", value: waiting, tone: "text-ink-black" },
            { label: "Needs review", value: counts.NEEDS_REVIEW, tone: "text-ink-amber" },
            { label: "Signed", value: counts.SIGNED, tone: "text-ink-blue" },
            { label: "Rejected", value: counts.REJECTED, tone: "text-ink-red" },
          ].map((card) => (
            <div key={card.label} className="bg-ink-card border border-ink-border rounded px-4 py-3">
              <p className={`font-mono text-xl font-medium ${card.tone}`}>{card.value}</p>
              <p className="text-[11px] font-mono text-ink-muted uppercase tracking-wide mt-0.5">{card.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Filters ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {TABS.map((t) => (
          <button
            key={t.key || "all"}
            onClick={() => setFilters({ ...filters, status: t.key ? [t.key] : [] })}
            aria-pressed={tab === t.key}
            className={`act ${tab === t.key ? "!bg-ink-black !text-white !border-ink-black" : ""}`}
          >
            {t.label}
            {counts && t.key && <span className="opacity-70">{counts[t.key]}</span>}
          </button>
        ))}
      </div>
      <RecordFilterBar
        state={filters}
        onChange={setFilters}
        config={barConfig}
        total={list.total}
        loading={list.loading}
        exportHref={list.csvHref}
      />

      {/* ── Table ───────────────────────────────────────────── */}
      {list.loading && rows.length === 0 ? (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-ink-muted">Loading credit notes…</p>
        </div>
      ) : list.error && rows.length === 0 ? (
        <div className="bg-ink-red-dim border border-ink-red/20 rounded p-6 text-center">
          <p className="text-sm font-mono text-ink-red">{list.error}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <p className="font-mono text-sm text-ink-black mb-1">No credit notes{list.total === 0 && (filters.q || filters.status.length || filters.from || filters.to || filters.preset || filters.customer || filters.flag) ? " match" : " yet"}</p>
          <p className="text-xs text-ink-muted">
            They appear here once the accounting software saves them to the credits folder, or when you upload one.
          </p>
        </div>
      ) : (
        <div className="bg-ink-card border border-ink-border rounded overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-mono text-ink-muted uppercase tracking-wide border-b border-ink-border">
                <th className="px-4 py-2.5">Credit no</th>
                <th className="px-4 py-2.5">Date</th>
                <th className="px-4 py-2.5">Invoice</th>
                <th className="px-4 py-2.5">Customer</th>
                <th className="px-4 py-2.5">Collections</th>
                <th className="px-4 py-2.5 text-right">Total</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setOpenId(r.id)}
                  className="border-b border-ink-border last:border-0 hover:bg-ink-surface cursor-pointer"
                >
                  <td className="px-4 py-2.5 font-mono text-ink-black whitespace-nowrap">
                    {r.creditNo ? (
                      <DocChip kind="CN" number={r.creditNo} tone={creditNoteTone(r.status)} />
                    ) : (
                      <span className="text-ink-muted">{r.sourceFilename}</span>
                    )}
                    {r.fileError && <span className="ml-1 text-ink-red" title={r.fileError}>!</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-ink-muted whitespace-nowrap">{formatDate(r.creditDate)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {r.invoiceNo ? <DocChip kind="INV" number={r.invoiceNo} tone="ref" /> : "—"}
                  </td>
                  <td className="px-4 py-2.5">{r.customerName ? <Highlight text={r.customerName} query={filters.q} /> : "—"}</td>
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {r.collectionNos.length ? r.collectionNos.join(", ") : <span className="text-ink-muted">none</span>}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-right whitespace-nowrap">{money(r.total)}</td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <StatusBadge status={r.status} />
                    {r.status === "SIGNED" && r.filingError && (
                      <Badge tone="amber" title={r.filingError} className="ml-2">Filing pending</Badge>
                    )}
                    {r.status !== "SIGNED" && r.status !== "REJECTED" && (r.reviewCount > 0 || r.warningCount > 0) && (
                      <span className="ml-2 text-[11px] font-mono text-ink-muted">
                        {r.reviewCount > 0 && <span className="text-ink-amber">{r.reviewCount} to check</span>}
                        {r.reviewCount > 0 && r.warningCount > 0 && " · "}
                        {r.warningCount > 0 && `${r.warningCount} note${r.warningCount === 1 ? "" : "s"}`}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.next && (
            <div className="px-4 py-3 border-t border-ink-border text-center">
              <button type="button" onClick={list.loadMore} disabled={list.loadingMore} className="act">
                {list.loadingMore ? "Loading…" : `Load more · ${rows.length} of ${list.total ?? "?"}`}
              </button>
            </div>
          )}
        </div>
      )}

      {openId && <CreditDetailPanel id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

// ─── One note ────────────────────────────────────────────────────────────

function CreditDetailPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [note, setNote] = useState<CreditDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Bumped to load the note again (after signing). */
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/credit-notes/${id}`)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(data.error || "Failed to load the credit note");
        else setNote(data.creditNote);
      })
      .catch(() => !cancelled && setError("Network error"));
    return () => {
      cancelled = true;
    };
  }, [id, version]);

  const act = async (key: string, body: object) => {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(`/api/credit-notes/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "That did not work");
      else {
        setNote(data.creditNote);
        onChanged();
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(null);
    }
  };

  const live = note && (note.status === "RECEIVED" || note.status === "NEEDS_REVIEW");
  const reviews = note?.issues.filter((i) => i.level === "review") ?? [];
  const warnings = note?.issues.filter((i) => i.level === "warning") ?? [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 animate-fade-in" onClick={onClose}>
      <div
        className="h-full w-full max-w-3xl bg-white shadow-xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-white border-b border-ink-border px-4 sm:px-6 py-4 flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="font-mono text-base font-medium text-ink-black truncate">
              {note?.creditNo ? (
                <span className="inline-flex items-center gap-2">
                  Credit note <DocChip kind="CN" number={note.creditNo} tone={creditNoteTone(note.status)} />
                </span>
              ) : (
                note?.sourceFilename ?? "Credit note"
              )}
            </h2>
            {note && <p className="text-xs text-ink-muted font-mono truncate">{note.sourceFilename}</p>}
          </div>
          {note && <StatusBadge status={note.status} />}
          <a
            href={`/api/credit-notes/${id}/document`}
            target="_blank"
            rel="noreferrer"
            className="act"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            {note?.status === "SIGNED" ? "Open signed copy" : "Open PDF"}
          </a>
          {live && (
            <button
              onClick={() => act("reread", { action: "reread" })}
              disabled={!!busy}
              className="act"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              {busy === "reread" ? "Reading…" : "Read again"}
            </button>
          )}
          <button onClick={onClose} className="act act-icon" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="px-4 sm:px-6 py-5 space-y-6">
          {error && <p className="text-sm font-mono text-ink-red">{error}</p>}
          {!note && !error && <p className="text-sm font-mono text-ink-muted">Loading…</p>}

          {note && (
            <>
              {/* Issues */}
              {note.status === "REJECTED" && note.rejectReason && (
                <div className="px-4 py-3 rounded border bg-ink-red-dim border-ink-red/20 text-sm text-ink-black">
                  <p className="font-mono text-xs text-ink-red uppercase tracking-wide mb-1">Rejected</p>
                  {note.rejectReason}
                </div>
              )}
              {note.status !== "REJECTED" && reviews.length > 0 && (
                <div className="px-4 py-3 rounded border bg-ink-amber-dim border-ink-amber/20">
                  <p className="font-mono text-xs text-ink-amber uppercase tracking-wide mb-1">To check before signing</p>
                  <ul className="text-sm text-ink-black list-disc pl-5 space-y-0.5">
                    {reviews.map((i, n) => <li key={n}>{i.message}</li>)}
                  </ul>
                </div>
              )}
              {note.status !== "REJECTED" && warnings.length > 0 && (
                <div className="px-4 py-3 rounded border bg-ink-surface border-ink-border">
                  <p className="font-mono text-xs text-ink-muted uppercase tracking-wide mb-1">Notes</p>
                  <ul className="text-sm text-ink-black list-disc pl-5 space-y-0.5">
                    {warnings.map((i, n) => <li key={n}>{i.message}</li>)}
                  </ul>
                </div>
              )}
              {note.fileError && <p className="text-xs font-mono text-ink-red">{note.fileError}</p>}

              {/* The invoice this note credits — its whole chain, one tap away. */}
              {note.invoice && (
                <Link href={`/invoices/${note.invoice.id}`} className="act" title="Delivery, collections and credit notes for this invoice">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" />
                    <path d="M6 8.5v7M8.5 18h7" />
                  </svg>
                  Invoice chain
                </Link>
              )}

              {/* Header */}
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {[
                  ["Credits invoice", note.invoiceNo ?? "—"],
                  [
                    "Invoice on record",
                    note.invoice
                      ? [note.invoice.customerName, note.invoice.invoiceDate && formatDate(note.invoice.invoiceDate), note.invoice.isStub ? "no PDF on file" : null]
                          .filter(Boolean)
                          .join(" · ") || "yes"
                      : "not on record",
                  ],
                  ["Credit date", formatDate(note.creditDate)],
                  ["Account", note.accountNo ?? "—"],
                  ["Deliver to", note.deliverToName ?? "—"],
                  ["Invoice to", note.billToName ?? "—"],
                  [
                    "Received",
                    `${ago(note.receivedAt)}${note.uploadedBy ? ` · uploaded by ${note.uploadedBy}` : " · from the folder"}`,
                  ],
                  ["Read", note.readError ? "could not be read" : note.readSource === "AI" ? "from a scan" : "from the PDF's text"],
                ].map(([label, value]) => (
                  <div key={label} className="flex gap-2">
                    <dt className="w-36 shrink-0 text-[11px] font-mono text-ink-muted uppercase tracking-wide pt-0.5">{label}</dt>
                    <dd className="text-ink-black">{value}</dd>
                  </div>
                ))}
              </dl>

              {/* Lines */}
              <div>
                <h3 className="font-mono text-xs text-ink-muted uppercase tracking-wide mb-2">Lines</h3>
                {note.lines.length === 0 ? (
                  <p className="text-sm text-ink-muted">No lines were read.</p>
                ) : (
                  <div className="border border-ink-border rounded overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-[11px] font-mono text-ink-muted uppercase tracking-wide border-b border-ink-border">
                          <th className="px-3 py-2">Product</th>
                          <th className="px-3 py-2">Description</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Nett</th>
                          <th className="px-3 py-2">Collected</th>
                        </tr>
                      </thead>
                      <tbody>
                        {note.lines.map((l) => (
                          <tr key={l.lineNo} className="border-b border-ink-border last:border-0 align-top">
                            <td className="px-3 py-2 font-mono whitespace-nowrap">{l.productCode ?? "—"}</td>
                            <td className="px-3 py-2">
                              {l.description}
                              {l.shortName && l.shortName !== l.description && (
                                <span className="block text-[11px] text-ink-muted">{l.shortName}</span>
                              )}
                            </td>
                            <td className="px-3 py-2 font-mono text-right">{l.qty}</td>
                            <td className="px-3 py-2 font-mono text-right whitespace-nowrap">
                              {money(l.nett)}
                              {l.discountPct ? <span className="block text-[11px] text-ink-muted">less {l.discountPct}%</span> : null}
                            </td>
                            <td className="px-3 py-2 text-xs font-mono">
                              {!l.match && note.status === "SIGNED" ? (
                                // Signed: what it was frozen at, at signing.
                                note.allocations.some((a) => a.lineNo === l.lineNo) ? (
                                  <span className="text-ink-green">
                                    ✓ {note.allocations.filter((a) => a.lineNo === l.lineNo).map((a) => `${a.qty} on ${a.collectionNo}`).join(", ")}
                                  </span>
                                ) : (
                                  <span className="text-ink-muted">not matched</span>
                                )
                              ) : !l.match ? (
                                <span className="text-ink-muted">—</span>
                              ) : l.match.status === "MATCHED" ? (
                                <span className="text-ink-green">
                                  ✓ {l.match.allocations.map((a) => `${a.qty} on ${a.collectionNo}`).join(", ")}
                                </span>
                              ) : l.match.status === "OVER" ? (
                                <span className="text-ink-amber">
                                  {l.match.uncoveredQty} more than came back
                                  {l.match.allocations.length > 0 &&
                                    ` (${l.match.allocations.map((a) => `${a.qty} on ${a.collectionNo}`).join(", ")})`}
                                </span>
                              ) : (
                                <span className="text-ink-amber">not collected</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="mt-2 flex flex-col items-end text-sm font-mono gap-0.5">
                  <span>
                    <span className="text-ink-muted">Sub total</span> {money(note.subtotal)}
                  </span>
                  <span>
                    <span className="text-ink-muted">VAT</span> {money(note.vatAmount)}
                  </span>
                  <span className="font-medium">
                    <span className="text-ink-muted">Total</span> {money(note.total)}
                  </span>
                </div>
              </div>

              {/* Collections */}
              <div>
                <h3 className="font-mono text-xs text-ink-muted uppercase tracking-wide mb-2">Collections this note pays for</h3>
                {note.collections.length === 0 ? (
                  <p className="text-sm text-ink-muted">
                    None yet. Collections are found through the invoice; link one below if it was booked against another.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {note.collections.map((c) => (
                      <li
                        key={c.linkId}
                        className={`border rounded px-3 py-2 ${c.source === "EXCLUDED" ? "border-dashed border-ink-border opacity-60" : "border-ink-border"}`}
                      >
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                          <DocChip kind={collectionKind({ type: "CREDIT_RETURN", originalInvoiceNo: c.originalInvoiceNo })} number={c.collectionNo} tone={collectionTone(c.status)} />
                          <span className="text-[11px] font-mono text-ink-muted">
                            {c.status.toLowerCase()} {c.collectedAt ? `· ${ago(c.collectedAt)}` : ""}
                            {" · "}
                            {c.source === "AUTO" ? "found through the invoice" : c.source === "MANUAL" ? `linked by ${c.linkedBy ?? "the office"}` : "taken off this note"}
                          </span>
                          {live && (
                            <button
                              onClick={() => act(c.linkId, { action: c.source === "EXCLUDED" ? "link" : "unlink", collectionId: c.id })}
                              disabled={!!busy}
                              className={`act ml-auto ${c.source === "EXCLUDED" ? "" : "act-danger"}`}
                            >
                              {c.source === "EXCLUDED" ? "Put back" : "Not this one"}
                            </button>
                          )}
                        </div>
                        {c.source !== "EXCLUDED" && (
                          <p className="text-xs text-ink-muted mt-1">
                            {c.lines.length === 0
                              ? "Recorded without sheet lines."
                              : c.lines
                                  .filter((cl) => cl.type === "CREDIT_RETURN")
                                  .map((cl) => `${cl.itemCode ?? cl.description}: ${cl.qtyCollected ?? 0} of ${cl.qtyListed}${cl.isExtra ? " (extra)" : ""}`)
                                  .join(" · ")}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {live && note.candidates.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">Could also be</p>
                    <ul className="space-y-1">
                      {note.candidates.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                          <DocChip kind={collectionKind({ type: "CREDIT_RETURN", originalInvoiceNo: c.originalInvoiceNo })} number={c.collectionNo} tone={collectionTone(c.status)} />
                          <span className="text-[11px] font-mono text-ink-muted inline-flex items-center gap-1.5 flex-wrap">
                            {c.customerName}
                            {c.originalInvoiceNo && (
                              <>
                                · against <DocChip kind="INV" number={c.originalInvoiceNo} tone="ref" />
                              </>
                            )}
                            {c.collectedAt ? ` · ${ago(c.collectedAt)}` : ""}
                          </span>
                          <button
                            onClick={() => act(c.id, { action: "link", collectionId: c.id })}
                            disabled={!!busy}
                            className="act act-green ml-auto"
                          >
                            Link
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* Sign-off: the form while the note waits, the record once signed. */}
              {live && (
                <SignOffForm
                  id={id}
                  issues={note.issues}
                  canSign={!note.readError && !!note.creditNo}
                  onDone={() => {
                    setVersion((v) => v + 1);
                    onChanged();
                  }}
                  onReject={(reason) => act("reject", { action: "reject", reason })}
                  busy={!!busy}
                />
              )}
              {note.status === "SIGNED" && (
                <div className="border-t border-ink-border pt-4 space-y-2">
                  <h3 className="font-mono text-xs text-ink-muted uppercase tracking-wide">Signed off</h3>
                  <p className="text-sm text-ink-black">
                    <span className="font-medium">{note.signedByName}</span>
                    <span className="text-ink-muted">
                      {" "}· office login {note.signedByLogin} · {note.signedAt ? ago(note.signedAt) : ""}
                    </span>
                  </p>
                  {note.acknowledgedIssues.length > 0 && (
                    <div className="text-xs text-ink-muted">
                      Accepted despite: {note.acknowledgedIssues.map((i) => i.message).join(" ")}
                      {note.acknowledgement && <span className="block text-ink-black mt-0.5">Reason: {note.acknowledgement}</span>}
                    </div>
                  )}
                  {note.signedFilename ? (
                    <p className="text-xs font-mono text-ink-muted flex items-center gap-2 flex-wrap">
                      <span>
                        Filed in Signed/ as {note.signedFilename}
                        {note.originalRemoved ? " · original removed from Originals/" : ""}
                      </span>
                      <a href={`/api/credit-notes/${id}/document`} target="_blank" rel="noreferrer" className="act">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                        Open signed copy
                      </a>
                    </p>
                  ) : null}
                  {note.filingError && (
                    <div className="px-3 py-2 rounded border bg-ink-amber-dim border-ink-amber/20 text-xs text-ink-black flex flex-wrap items-center gap-2">
                      <span className="flex-1">Filing has not finished: {note.filingError}</span>
                      <button
                        onClick={() => act("file", { action: "file" })}
                        disabled={!!busy}
                        className="act act-amber"
                      >
                        {busy === "file" ? "Filing…" : "Retry filing"}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {note.status === "REJECTED" && note.rejectedBy && (
                <p className="text-xs font-mono text-ink-muted border-t border-ink-border pt-4">
                  Rejected by {note.rejectedBy}
                  {note.rejectedAt ? ` · ${ago(note.rejectedAt)}` : ""}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Signing off ─────────────────────────────────────────────────────────

/**
 * The dispatcher's sign-off: their typed name and drawn signature, under their
 * own office login. Whatever the check found has to be accepted with a reason
 * — it is printed on the sign-off page with the signature. Or the note is
 * rejected, with a reason, and moved to Rejected/.
 */
function SignOffForm({
  id,
  issues,
  canSign,
  onDone,
  onReject,
  busy,
}: {
  id: string;
  issues: Issue[];
  canSign: boolean;
  onDone: () => void;
  onReject: (reason: string) => void;
  busy: boolean;
}) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [name, setName] = useState("");
  const [ack, setAck] = useState("");
  const [hasSignature, setHasSignature] = useState(false);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const ready = canSign && name.trim().length >= 2 && hasSignature && (issues.length === 0 || ack.trim().length >= 5);

  const sign = async () => {
    const signatureImage = padRef.current?.toDataURL();
    if (!signatureImage) {
      setError("Draw your signature to sign.");
      return;
    }
    setSigning(true);
    setError(null);
    try {
      const res = await fetch(`/api/credit-notes/${id}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedByName: name.trim(), signatureImage, acknowledgement: ack.trim() }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "The credit note could not be signed");
      else onDone();
    } catch {
      setError("Network error");
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="border-t border-ink-border pt-4 space-y-3">
      <h3 className="font-mono text-xs text-ink-muted uppercase tracking-wide">Sign off</h3>
      {!canSign ? (
        <p className="text-sm text-ink-amber">
          This note was not read properly, so it cannot be signed. Read it again, or reject it.
        </p>
      ) : (
        <>
          {issues.length > 0 && (
            <label className="block">
              <span className="text-xs text-ink-black">
                The check above found {issues.length} thing{issues.length === 1 ? "" : "s"}. Why is it fine to sign anyway?
              </span>
              <textarea
                value={ack}
                onChange={(e) => setAck(e.target.value)}
                rows={2}
                maxLength={600}
                placeholder="e.g. Customer kept one unit; credit agreed with accounts"
                className="mt-1 w-full px-3 py-2 text-sm bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green resize-y"
              />
            </label>
          )}
          <label className="block">
            <span className="text-xs text-ink-black">Your name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="As it should appear on the sign-off page"
              className="mt-1 w-full sm:w-80 px-3 py-2 text-sm bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
            />
          </label>
          <div className="max-w-md">
            <SignaturePad ref={padRef} onChange={setHasSignature} label="Your signature" placeholder="Sign here" height={130} />
          </div>
          <p className="text-[11px] text-ink-muted">
            Signed under your office login. A sign-off page is added to the credit note, the signed copy is filed in
            Signed/ and the original is removed from Originals/.
          </p>
          {error && <p className="text-xs font-mono text-ink-red">{error}</p>}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canSign && (
          <button
            onClick={sign}
            disabled={!ready || signing || busy}
            className="act act-primary"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
            {signing ? "Signing…" : "Sign credit note"}
          </button>
        )}
        {!rejecting ? (
          <button
            onClick={() => setRejecting(true)}
            disabled={signing || busy}
            className="act act-danger"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
            Reject…
          </button>
        ) : (
          <div className="w-full flex flex-wrap items-center gap-2">
            <input
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              maxLength={600}
              placeholder="Why it will not be signed (moved to Rejected/)"
              className="flex-1 min-w-[14rem] px-3 py-2 text-sm bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-red"
            />
            <button
              onClick={() => onReject(rejectReason.trim())}
              disabled={rejectReason.trim().length < 3 || busy}
              className="act act-red"
            >
              Reject credit note
            </button>
            <button onClick={() => setRejecting(false)} className="act">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
