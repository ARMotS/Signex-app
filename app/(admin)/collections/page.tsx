"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { DocChip, StatusBadge, collectionKind, collectionTone } from "@/components/ui/Chips";
import { awaitingCreditReview } from "@/lib/collection-confirm";

/**
 * The dispatcher's collections view and the credit-return report accounts
 * reconciles from.
 *
 * Reads live collections and the frozen entries in completed trips' archives
 * together — a report that only showed live rows would empty out every evening
 * as trips are closed, which is exactly when someone sits down to reconcile it.
 */

interface CollectionRecord {
  id: string | null;
  collectionNo: string;
  type: "CREDIT_RETURN" | "NON_CREDIT_UPLIFT";
  upliftSubtype: string | null;
  originalInvoiceNo: string | null;
  status: "PENDING" | "COLLECTED" | "PARTIAL" | "NOT_AVAILABLE" | "REFUSED";
  exceptionReason: string | null;
  notes: string | null;
  expectedQty: number | null;
  collectedQty: number | null;
  customerName: string;
  stopNumber: number | null;
  signedByName: string | null;
  collectedAt: string | null;
  sourceFilePath: string | null;
  signedFileId: string | null;
  signedFilePath: string | null;
  driverId: string | null;
  driverName: string | null;
  emailStatus: "NOT_SENT" | "SENDING" | "SENT" | "FAILED" | "NO_EMAIL" | null;
  emailError: string | null;
  /** The driver recorded "Not as listed". */
  hasVariance?: boolean;
  /** Items on the office's sheet / items back — null when no sheet was read. */
  itemsListed?: number | null;
  itemsCollected?: number | null;
  /** The office's decision on a CR that came back; null when none (yet). */
  creditReview?: "APPROVED" | "REJECTED" | null;
  creditReviewReason?: string | null;
  /** The invoice registry row it is credited against — its chain page. */
  invoiceId?: string | null;
  tripSheetId: string;
  archived: boolean;
  completedTripSheetId: string | null;
}

interface Counts {
  total: number;
  pending: number;
  collected: number;
  partial: number;
  notAvailable: number;
  refused: number;
  creditReturns: number;
  uplifts: number;
  exceptions: number;
}

const STATUS_LABEL: Record<CollectionRecord["status"], string> = {
  PENDING: "Pending",
  COLLECTED: "Collected",
  PARTIAL: "Partial",
  NOT_AVAILABLE: "Not available",
  REFUSED: "Refused",
};

const SUBTYPE_LABEL: Record<string, string> = {
  COMPANY_PARCEL: "Company parcel",
  EQUIPMENT_OR_CRATES: "Equipment / crates",
  DOCUMENTS: "Documents",
  SPECIAL_REQUEST: "Special request",
};

/** Outcomes the customer signed for — the only ones a receipt is emailed for. */
const RECEIPT_STATUSES = new Set(["COLLECTED", "PARTIAL"]);

const EMAIL_LABEL: Record<string, { text: string; tone: string }> = {
  SENT: { text: "Emailed", tone: "text-ink-green" },
  SENDING: { text: "Sending…", tone: "text-ink-muted" },
  FAILED: { text: "Email failed", tone: "text-ink-red" },
  NO_EMAIL: { text: "No email on file", tone: "text-ink-amber" },
  NOT_SENT: { text: "Not emailed", tone: "text-ink-muted" },
};

interface FolderDocument {
  filename: string;
  sizeBytes: number;
  lastModified: string;
}

interface FolderListing {
  source: "onedrive" | "local";
  folderPath: string | null;
  error: string | null;
  pending: FolderDocument[];
  signed: FolderDocument[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What is actually in the collections folder.
 *
 * The table below only shows collections that have arrived on a trip sheet, so
 * without this an admin could not tell an empty folder from an unreadable one —
 * and both made every COLLECTNO on an import read as "no document".
 */
function FolderPanel() {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [showSigned, setShowSigned] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(null);
    try {
      const res = await fetch("/api/collections/folder");
      const data = await res.json();
      if (!res.ok) {
        setFailed(data.error || "Failed to read the collections folder");
        return;
      }
      setListing(data);
    } catch {
      setFailed("Failed to connect to server");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const error = failed ?? listing?.error ?? null;
  const docs = showSigned ? listing?.signed ?? [] : listing?.pending ?? [];

  return (
    <div className="bg-ink-card border border-ink-border rounded mb-6">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-ink-border">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">
            Collections folder
            {listing && (
              <span className="ml-2 normal-case tracking-normal">
                · {listing.source === "onedrive" ? "OneDrive" : "Local folder"}
              </span>
            )}
          </p>
          <p className="font-mono text-[13px] text-ink-black truncate" title={listing?.folderPath ?? ""}>
            {listing?.folderPath || "No folder chosen"}
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs font-mono">
          <button
            onClick={() => setShowSigned(false)}
            className={`px-2.5 py-1 rounded ${!showSigned ? "bg-ink-surface text-ink-black" : "text-ink-muted hover:text-ink-black"}`}
          >
            Pending ({listing?.pending.length ?? 0})
          </button>
          <button
            onClick={() => setShowSigned(true)}
            className={`px-2.5 py-1 rounded ${showSigned ? "bg-ink-surface text-ink-black" : "text-ink-muted hover:text-ink-black"}`}
          >
            Signed ({listing?.signed.length ?? 0})
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="ml-2 px-3 py-1.5 border border-ink-border rounded hover:bg-ink-surface transition-colors disabled:opacity-40"
          >
            {loading ? "Reading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div className="px-4 py-3 bg-ink-red-dim">
          <p className="text-[13px] font-mono text-ink-red">{error}</p>
          <a href="/settings" className="text-xs font-mono text-ink-muted hover:text-ink-black underline">
            Open Settings
          </a>
        </div>
      ) : loading && !listing ? (
        <p className="px-4 py-4 text-sm font-mono text-ink-muted">Reading folder…</p>
      ) : docs.length === 0 ? (
        <p className="px-4 py-4 text-xs text-ink-muted">
          {showSigned
            ? "Nothing signed yet. Signed receipts are filed in the Signed subfolder."
            : "No PDFs found. Put collection documents in this folder or its Pending subfolder, named by collection number (e.g. COL-118.pdf)."}
        </p>
      ) : (
        <div className="divide-y divide-ink-border max-h-72 overflow-y-auto">
          {docs.map((d) => (
            <div key={d.filename} className="flex items-center gap-3 px-4 py-2">
              <span className="font-mono text-[13px] text-ink-black truncate flex-1 min-w-0">
                {d.filename}
              </span>
              <span className="text-[11px] font-mono text-ink-muted shrink-0">
                {formatSize(d.sizeBytes)} ·{" "}
                {new Date(d.lastModified).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}
              </span>
              <a
                href={`/api/collections/document/${encodeURIComponent(d.filename)}${showSigned ? "?signed=true" : ""}`}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] font-mono text-ink-violet hover:underline shrink-0"
              >
                Open
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type TypeFilter = "" | "CREDIT_RETURN" | "NON_CREDIT_UPLIFT";
type StatusFilter = "" | CollectionRecord["status"];

export default function CollectionsPage() {
  const [records, setRecords] = useState<CollectionRecord[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<TypeFilter>("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [outstandingOnly, setOutstandingOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sendNote, setSendNote] = useState<{ id: string; text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (type) params.set("type", type);
      if (status) params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (exceptionsOnly) params.set("exceptions", "true");
      // "Outstanding" means work still to do, which by definition lives on a
      // trip nobody has closed yet.
      if (outstandingOnly) params.set("includeArchived", "false");

      const res = await fetch(`/api/collections?${params.toString()}`);
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to load collections");
        return;
      }

      setRecords(data.collections || []);
      setCounts(data.counts || null);
    } catch {
      setError("Failed to connect to server");
    } finally {
      setLoading(false);
    }
  }, [type, status, from, to, exceptionsOnly, outstandingOnly]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = records;
    if (outstandingOnly) rows = rows.filter((r) => r.status === "PENDING");
    if (!q) return rows;
    return rows.filter((r) =>
      [r.collectionNo, r.customerName, r.originalInvoiceNo, r.driverName, r.exceptionReason]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [records, query, outstandingOnly]);

  // The manual send — for a receipt that did not go out on its own, or another
  // copy. The automatic send on recording the outcome is the normal path.
  const sendReceipt = async (id: string) => {
    setSendingId(id);
    setSendNote(null);
    try {
      const res = await fetch(`/api/collections/${id}/notify`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        setSendNote({ id, text: `Sent to ${data.recipient}`, ok: true });
      } else if (data.skipped) {
        setSendNote({ id, text: data.reason, ok: false });
      } else {
        setSendNote({ id, text: data.error || "Send failed", ok: false });
      }
      await load();
    } catch {
      setSendNote({ id, text: "Failed to connect to server", ok: false });
    } finally {
      setSendingId(null);
    }
  };

  const exportCsv = () => {
    // A credit clerk reconciles in a spreadsheet, so the report has to leave as
    // one. Built in the browser from what is already on screen — no second
    // endpoint that could disagree with the table.
    const headers = [
      "Collection No",
      "Type",
      "Subtype",
      "Original Invoice",
      "Customer",
      "Status",
      "Expected",
      "Collected",
      "Reason",
      "Driver",
      "Signed By",
      "Collected At",
      "Signed Document",
      "Receipt Email",
    ];
    const rows = visible.map((r) => [
      r.collectionNo,
      r.type === "CREDIT_RETURN" ? "Credit Return" : "Uplift",
      r.upliftSubtype ? SUBTYPE_LABEL[r.upliftSubtype] ?? r.upliftSubtype : "",
      r.originalInvoiceNo ?? "",
      r.customerName,
      STATUS_LABEL[r.status] ?? r.status,
      r.expectedQty ?? "",
      r.collectedQty ?? "",
      r.exceptionReason ?? "",
      r.driverName ?? "",
      r.signedByName ?? "",
      r.collectedAt ? new Date(r.collectedAt).toISOString() : "",
      r.signedFilePath ?? "",
      r.emailStatus ? EMAIL_LABEL[r.emailStatus]?.text ?? r.emailStatus : "",
    ]);

    const escape = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const csv = [headers, ...rows].map((r) => r.map(escape).join(",")).join("\r\n");
    const blob = new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `signex-collections-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="animate-fade-in">
      <div className="mb-6">
        <h1 className="font-mono text-lg font-medium text-ink-black">Collections</h1>
        <p className="text-sm text-ink-muted mt-1">
          Credit returns and uplifts, across live trips and closed-out ones.
        </p>
      </div>

      <FolderPanel />

      {/* ── Summary ─────────────────────────────────────────── */}
      {counts && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {[
            { label: "Credit returns", value: counts.creditReturns, tone: "text-ink-violet" },
            { label: "Uplifts", value: counts.uplifts, tone: "text-ink-blue" },
            { label: "Outstanding", value: counts.pending, tone: "text-ink-muted" },
            { label: "Exceptions", value: counts.exceptions, tone: "text-ink-amber" },
          ].map((card) => (
            <div
              key={card.label}
              className="bg-ink-card border border-ink-border rounded px-4 py-3"
            >
              <p className={`font-mono text-xl font-medium ${card.tone}`}>{card.value}</p>
              <p className="text-[11px] font-mono text-ink-muted uppercase tracking-wide mt-0.5">
                {card.label}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* ── Filters ─────────────────────────────────────────── */}
      <div className="bg-ink-card border border-ink-border rounded p-4 mb-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Type</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as TypeFilter)}
              className="px-3 py-2 bg-ink-surface border border-ink-border rounded font-mono text-sm outline-none focus:border-ink-green"
            >
              <option value="">All</option>
              <option value="CREDIT_RETURN">Credit returns</option>
              <option value="NON_CREDIT_UPLIFT">Uplifts</option>
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className="px-3 py-2 bg-ink-surface border border-ink-border rounded font-mono text-sm outline-none focus:border-ink-green"
            >
              <option value="">All</option>
              {(Object.keys(STATUS_LABEL) as CollectionRecord["status"][]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-3 py-2 bg-ink-surface border border-ink-border rounded font-mono text-sm outline-none focus:border-ink-green"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-3 py-2 bg-ink-surface border border-ink-border rounded font-mono text-sm outline-none focus:border-ink-green"
            />
          </label>

          <label className="flex flex-col gap-1 flex-1 min-w-[12rem]">
            <span className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Search</span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Collection no, customer, invoice, driver…"
              className="px-3 py-2 bg-ink-surface border border-ink-border rounded font-mono text-sm outline-none focus:border-ink-green"
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs font-mono text-ink-muted cursor-pointer">
            <input
              type="checkbox"
              checked={exceptionsOnly}
              onChange={(e) => setExceptionsOnly(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-ink-border accent-[#F5A623]"
            />
            Exceptions only (partial / not available / refused)
          </label>
          <label className="flex items-center gap-2 text-xs font-mono text-ink-muted cursor-pointer">
            <input
              type="checkbox"
              checked={outstandingOnly}
              onChange={(e) => setOutstandingOnly(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F]"
            />
            Still outstanding
          </label>

          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs font-mono text-ink-muted">
              {visible.length} shown
            </span>
            <button
              onClick={exportCsv}
              disabled={visible.length === 0}
              className="px-3 py-1.5 text-xs font-mono border border-ink-border rounded hover:bg-ink-surface transition-colors disabled:opacity-40"
            >
              Export CSV
            </button>
          </div>
        </div>
      </div>

      {/* ── Table ───────────────────────────────────────────── */}
      {loading ? (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-ink-muted">Loading collections…</p>
        </div>
      ) : error ? (
        <div className="bg-ink-red-dim border border-ink-red/20 rounded p-6 text-center">
          <p className="text-sm font-mono text-ink-red">{error}</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <p className="font-mono text-sm text-ink-black mb-1">No collections match</p>
          <p className="text-xs text-ink-muted">
            Collections arrive on a trip sheet in the COLLECTNO column.
          </p>
        </div>
      ) : (
        <div className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <div className="hidden md:grid grid-cols-[10rem_1fr_1fr_9rem_12rem] gap-3 px-4 py-2 text-[11px] font-mono text-ink-muted uppercase tracking-wide bg-ink-surface/50 border-b border-ink-border">
            <div>Collection</div>
            <div>Customer</div>
            <div>Detail</div>
            <div>Outcome</div>
            <div className="text-right">Documents</div>
          </div>

          <div className="divide-y divide-ink-border">
            {visible.map((r) => (
              <div
                key={`${r.tripSheetId}-${r.collectionNo}-${r.id ?? "archived"}`}
                className="px-4 py-3 hover:bg-ink-surface/30 transition-colors md:grid md:grid-cols-[10rem_1fr_1fr_9rem_12rem] md:gap-3 md:items-center"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <DocChip kind={collectionKind(r)} number={r.collectionNo} tone={collectionTone(r.status)} />
                    {r.archived && (
                      <StatusBadge tone="idle" title="This trip has been closed out — read from the archive">
                        Archived
                      </StatusBadge>
                    )}
                  </div>
                </div>

                <div className="min-w-0 mt-2 md:mt-0">
                  <p className="text-[13px] text-ink-black truncate">{r.customerName}</p>
                  <p className="text-[11px] font-mono text-ink-muted truncate">
                    {r.driverName ?? "No driver"}
                    {r.collectedAt
                      ? ` · ${new Date(r.collectedAt).toLocaleDateString("en-ZA", {
                          day: "2-digit",
                          month: "short",
                        })}`
                      : " · not collected yet"}
                  </p>
                </div>

                <div className="min-w-0 mt-2 md:mt-0">
                  {(r.originalInvoiceNo || r.upliftSubtype) && (
                    <p className="text-[12px] text-ink-muted flex items-center gap-1.5 flex-wrap">
                      {r.originalInvoiceNo && (
                        <>
                          against <DocChip kind="INV" number={r.originalInvoiceNo} tone="ref" />
                        </>
                      )}
                      {r.upliftSubtype && <span>{SUBTYPE_LABEL[r.upliftSubtype] ?? r.upliftSubtype}</span>}
                    </p>
                  )}
                  {r.itemsListed != null ? (
                    // Items against the office's sheet; the box count is not an item count.
                    <p className="text-[12px] font-mono text-ink-muted">
                      {r.itemsCollected != null ? `${r.itemsCollected} of ${r.itemsListed} items` : `${r.itemsListed} items listed`}
                      {r.hasVariance && <span className="ml-2 text-ink-amber">· not as listed</span>}
                    </p>
                  ) : (
                    (r.collectedQty != null || r.expectedQty != null) && (
                      <p className="text-[12px] font-mono text-ink-muted">
                        {r.collectedQty ?? 0} of {r.expectedQty ?? "—"}
                      </p>
                    )
                  )}
                  {r.exceptionReason && (
                    <p className="text-[12px] text-ink-amber truncate" title={r.exceptionReason}>
                      {r.exceptionReason}
                    </p>
                  )}
                </div>

                <div className="mt-2 md:mt-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <StatusBadge tone={collectionTone(r.status)} dot>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </StatusBadge>
                    {/* The office's decision on a CR that came back. */}
                    {r.creditReview ? (
                      <StatusBadge
                        tone={r.creditReview === "APPROVED" ? "green" : "red"}
                        title={r.creditReviewReason ?? undefined}
                      >
                        {r.creditReview === "APPROVED" ? "Approved" : "Rejected"}
                      </StatusBadge>
                    ) : (
                      // Live only: a trip closed before approvals existed has none.
                      !r.archived && awaitingCreditReview(r) && (
                        <StatusBadge tone="amber" title="Approve or reject it on the trip card">
                          Awaiting approval
                        </StatusBadge>
                      )
                    )}
                  </div>
                  {RECEIPT_STATUSES.has(r.status) && r.emailStatus && (
                    <p
                      className={`text-[11px] font-mono mt-1 ${EMAIL_LABEL[r.emailStatus]?.tone ?? "text-ink-muted"}`}
                      title={r.emailError ?? undefined}
                    >
                      {EMAIL_LABEL[r.emailStatus]?.text ?? r.emailStatus}
                    </p>
                  )}
                  {sendNote?.id === r.id && (
                    <p className={`text-[11px] font-mono mt-0.5 ${sendNote.ok ? "text-ink-green" : "text-ink-amber"}`}>
                      {sendNote.text}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-wrap mt-2 md:mt-0 md:justify-end">
                  {r.signedFilePath ? (
                    <a
                      href={`/api/collections/document/${encodeURIComponent(r.signedFilePath)}?signed=true`}
                      target="_blank"
                      rel="noreferrer"
                      className="act"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Signed receipt
                    </a>
                  ) : (
                    <StatusBadge tone="idle">No receipt</StatusBadge>
                  )}
                  {/* Only for a receipt that did not go out: the email is sent
                      when the driver confirms, and this is the fallback. */}
                  {r.id && RECEIPT_STATUSES.has(r.status) && r.emailStatus !== "SENT" && (
                    <button
                      onClick={() => sendReceipt(r.id!)}
                      disabled={sendingId === r.id || r.emailStatus === "SENDING"}
                      className={`act ${r.emailStatus === "FAILED" ? "act-red" : ""}`}
                      title="Email the signed receipt to the customer"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                        <polyline points="22,6 12,13 2,6" />
                      </svg>
                      {sendingId === r.id ? "Sending…" : r.emailStatus === "FAILED" ? "Retry email" : "Send email"}
                    </button>
                  )}
                  {/* The invoice it is credited against, the whole chain. */}
                  {r.invoiceId && (
                    <Link href={`/invoices/${r.invoiceId}`} className="act" title="Delivery, collections and credit notes for this invoice">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" />
                        <path d="M6 8.5v7M8.5 18h7" />
                      </svg>
                      Invoice chain
                    </Link>
                  )}
                  {/* Only when there is a sheet to open (as on the trip card).
                      A live one is fetched by id; an archived one has no row
                      left, so it needs the filename frozen with it. */}
                  {r.sourceFilePath && (
                    <a
                      href={
                        r.id
                          ? `/api/collections/${r.id}/source`
                          : `/api/collections/document/${encodeURIComponent(r.sourceFilePath)}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="act"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      Office sheet
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
