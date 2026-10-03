"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

const EXCEPTIONS = new Set(["PARTIAL", "NOT_AVAILABLE", "REFUSED"]);

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

function statusBadgeClass(status: string): string {
  if (status === "COLLECTED") return "badge-signed";
  if (EXCEPTIONS.has(status)) return "badge-progress";
  return "badge-pending";
}

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
                  <div className="flex items-center gap-2">
                    <span
                      className={r.type === "CREDIT_RETURN" ? "badge-credit" : "badge-uplift"}
                    >
                      {r.type === "CREDIT_RETURN" ? "Credit" : "Uplift"}
                    </span>
                    {r.archived && (
                      <span
                        className="text-[10px] font-mono text-ink-muted-light"
                        title="This trip has been closed out — read from the archive"
                      >
                        ARCHIVED
                      </span>
                    )}
                  </div>
                  <p className="font-mono text-[13px] font-medium text-ink-black mt-1 truncate">
                    {r.collectionNo}
                  </p>
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
                  <p className="text-[12px] text-ink-muted truncate">
                    {r.originalInvoiceNo ? `Against ${r.originalInvoiceNo}` : ""}
                    {r.upliftSubtype
                      ? `${r.originalInvoiceNo ? " · " : ""}${SUBTYPE_LABEL[r.upliftSubtype] ?? r.upliftSubtype}`
                      : ""}
                  </p>
                  {(r.collectedQty != null || r.expectedQty != null) && (
                    <p className="text-[12px] font-mono text-ink-muted">
                      {r.collectedQty ?? 0} of {r.expectedQty ?? "—"}
                    </p>
                  )}
                  {r.exceptionReason && (
                    <p className="text-[12px] text-ink-amber truncate" title={r.exceptionReason}>
                      {r.exceptionReason}
                    </p>
                  )}
                </div>

                <div className="mt-2 md:mt-0">
                  <span className={statusBadgeClass(r.status)}>
                    {STATUS_LABEL[r.status] ?? r.status}
                  </span>
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

                <div className="flex items-center gap-3 mt-2 md:mt-0 md:justify-end">
                  {r.signedFilePath ? (
                    <a
                      href={`/api/collections/document/${encodeURIComponent(r.signedFilePath)}?signed=true`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] font-mono text-ink-violet hover:underline"
                    >
                      Receipt
                    </a>
                  ) : (
                    <span className="text-[11px] font-mono text-ink-muted-light">No receipt</span>
                  )}
                  {r.id && RECEIPT_STATUSES.has(r.status) && (
                    <button
                      onClick={() => sendReceipt(r.id!)}
                      disabled={sendingId === r.id || r.emailStatus === "SENDING"}
                      className="text-[11px] font-mono text-ink-muted hover:text-ink-black hover:underline disabled:opacity-40"
                      title="Email the signed receipt to the customer"
                    >
                      {sendingId === r.id ? "Sending…" : r.emailStatus === "SENT" ? "Resend" : "Email"}
                    </button>
                  )}
                  {r.sourceFilePath && (
                    <a
                      href={`/api/collections/document/${encodeURIComponent(r.sourceFilePath)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] font-mono text-ink-muted hover:text-ink-black hover:underline"
                    >
                      Original
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
