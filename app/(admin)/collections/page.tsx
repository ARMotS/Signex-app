"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { DocChip, StatusBadge, collectionKind, collectionTone } from "@/components/ui/Chips";
import {
  CREDIT_CHARGE_LABEL,
  awaitingCreditReview,
  creditReviewRequired,
  type CreditCharge,
  type ReasonLine,
} from "@/lib/collection-confirm";
import CreditReviewControl, {
  ChargeBoxes,
  CreditBadge,
  RejectCreditDialog,
  submitCreditDecision,
} from "@/components/admin/CreditReviewControl";
import RecordFilterBar, { Highlight, type FilterBarConfig } from "@/components/admin/RecordFilterBar";
import CollectionSheetUpload from "@/components/admin/CollectionSheetUpload";
import { usePagedRecords, useRecordFilters } from "@/hooks/useRecordFilters";
import { useLiveSync } from "@/hooks/useLiveSync";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import Pager from "@/components/ui/Pager";
import StatusTabs from "@/components/ui/StatusTabs";

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
  creditReviewedBy?: string | null;
  /** The sheet's handling-charge box ticked with the decision. */
  creditCharge?: CreditCharge | null;
  /** Sheet lines with something to explain: the office's reason, what differed. */
  reasonLines?: ReasonLine[];
  /** Other collections on the same invoice — a credit could be doubled. */
  othersOnInvoice?: number;
  /** The Collection row behind it (archived entries too) — what an approval acts on. */
  rowId?: string | null;
  /** The invoice registry row it is credited against — its chain page. */
  invoiceId?: string | null;
  tripSheetId: string;
  archived: boolean;
  completedTripSheetId: string | null;
  tripDate?: string | null;
  tripName?: string | null;
}

interface Counts {
  total: number;
  pending: number;
  creditReturns: number;
  uplifts: number;
  exceptions: number;
  /** Across the whole scope — a to-do count, not the filtered view. */
  awaitingApproval?: number;
  /** What the other filters let through, whichever tab is open. */
  tabs?: { all: number; active: number; completed: number; awaiting: number; approved: number; rejected: number };
  itemsCollected?: number;
  receiptNotEmailed?: number;
}

interface PageExtra {
  counts: Counts;
  facets: { customers: string[]; drivers: { id: string; name: string }[]; trips: { id: string; name: string }[] };
  /** The read behind the list stopped at its ceiling: older rows need a date range. */
  capped?: boolean;
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

/** What each tab can be narrowed to, as Trip Sheets' tabs have their own filters. Tags are the route's accessors. */
const TAB_STATUSES = {
  active: [
    { value: "PENDING", label: "Pending" },
    { value: "AWAITING_APPROVAL", label: "Awaiting approval" },
  ],
  completed: [
    { value: "CREDIT_APPROVED", label: "Approved for credit" },
    { value: "CREDIT_REJECTED", label: "Rejected for credit" },
    { value: "COLLECTED", label: "Collected" },
    { value: "PARTIAL", label: "Partial" },
    { value: "NOT_AVAILABLE", label: "Not available" },
    { value: "REFUSED", label: "Refused" },
  ],
};

/** Tailwind must see the whole class, so the columns live in one place. */
const COLUMNS = "xl:grid-cols-[1.25rem_9rem_minmax(0,1.1fr)_4.5rem_minmax(0,1.4fr)_10.5rem_6rem]";

/** Lines of reason on the row; the rest are one click away in the details. */
const REASONS_SHOWN = 3;

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
 * and both made every COLLECTNO on an import read as "no document". One quiet
 * line under the list until opened; a folder it cannot read still says so.
 */
function FolderPanel({ refreshKey }: { refreshKey: number }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [showSigned, setShowSigned] = useState(false);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
  }, [load, refreshKey]);

  const removeDocument = async (filename: string) => {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/collections/sheets/${encodeURIComponent(filename)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteError(data.error || "That sheet could not be deleted");
        return;
      }
      setDeleting(null);
      load();
    } catch {
      setDeleteError("Failed to connect to server");
    } finally {
      setDeleteBusy(false);
    }
  };

  const error = failed ?? listing?.error ?? null;
  const docs = showSigned ? listing?.signed ?? [] : listing?.pending ?? [];

  return (
    <div className="bg-ink-card border border-ink-border rounded mt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
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
        <div className="flex flex-wrap items-center gap-1 text-xs font-mono">
          <button
            onClick={() => {
              setShowSigned(false);
              setOpen(true);
            }}
            className={`px-2.5 py-1 rounded ${!showSigned ? "bg-ink-surface text-ink-black" : "text-ink-muted hover:text-ink-black"}`}
          >
            Pending ({listing?.pending.length ?? 0})
          </button>
          <button
            onClick={() => {
              setShowSigned(true);
              setOpen(true);
            }}
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
          {open && (
            <button onClick={() => setOpen(false)} className="px-2.5 py-1 rounded text-ink-muted hover:text-ink-black">
              Hide
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="px-4 py-3 bg-ink-red-dim border-t border-ink-border">
          <p className="text-[13px] font-mono text-ink-red break-words">{error}</p>
          <a href="/settings" className="text-xs font-mono text-ink-muted hover:text-ink-black underline">
            Open Settings
          </a>
        </div>
      ) : !open ? null : loading && !listing ? (
        <p className="px-4 py-4 text-sm font-mono text-ink-muted border-t border-ink-border">Reading folder…</p>
      ) : docs.length === 0 ? (
        <p className="px-4 py-4 text-xs text-ink-muted border-t border-ink-border">
          {showSigned
            ? "Nothing signed yet. Signed receipts are filed in the Signed subfolder."
            : "No PDFs found. Put collection documents in this folder or its Pending subfolder, named by collection number (e.g. COL-118.pdf)."}
        </p>
      ) : (
        <div className="divide-y divide-ink-border max-h-72 overflow-y-auto border-t border-ink-border">
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
              {/* Signed/ is the permanent record: nothing deletes from it. */}
              {!showSigned && (
                <button
                  type="button"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleting(d.filename);
                  }}
                  className="text-[11px] font-mono text-ink-muted hover:text-ink-red shrink-0"
                  aria-label={`Delete ${d.filename}`}
                >
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting}?`}
          confirmLabel="Delete sheet"
          busyLabel="Deleting…"
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={() => removeDocument(deleting)}
        >
          <p>It is removed from the collections folder for good. Upload it again if it is needed.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default function CollectionsPage() {
  const [filters, setFilters, filtersLoaded] = useRecordFilters("collections");
  // Active unless chosen. Always asked for by name: a request with no tab still
  // means every row, which is what a tab on an older bundle sends.
  const tab = filters.tab || "active";
  const list = usePagedRecords<CollectionRecord, PageExtra>("/api/collections", "collections", { ...filters, tab }, filtersLoaded);
  // A row changes tab when a driver or another dispatcher changes its status.
  useLiveSync(list.reload);
  const records = list.items;
  const counts = list.extra?.counts ?? null;
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [sendNote, setSendNote] = useState<{ id: string; text: string; ok: boolean } | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCharge, setBulkCharge] = useState<CreditCharge | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkNote, setBulkNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [bulkRejecting, setBulkRejecting] = useState(false);
  const [bulkReason, setBulkReason] = useState("");
  const [folderKey, setFolderKey] = useState(0);
  const [removing, setRemoving] = useState<CollectionRecord | null>(null);
  const [removeReason, setRemoveReason] = useState("");
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Looked up each render, so the panel shows the row as it now stands.
  const opened = openKey ? records.find((r) => recordKey(r) === openKey) ?? null : null;

  const barConfig: FilterBarConfig = {
    searchPlaceholder: "Collection no, customer, invoice, driver, reason…",
    noun: "collection",
    dateLabel: "Collected",
    tripDate: true,
    statusOptions: TAB_STATUSES[tab],
    typeOptions: [
      { value: "CREDIT_RETURN", label: "Credit returns" },
      { value: "NON_CREDIT_UPLIFT", label: "Uplifts" },
    ],
    sortOptions: [
      { value: "date_desc", label: "Newest first" },
      { value: "date_asc", label: "Oldest first" },
      { value: "customer", label: "Customer A–Z" },
      { value: "number", label: "Collection no" },
      { value: "status", label: "Status" },
    ],
    customers: list.extra?.facets.customers,
    drivers: list.extra?.facets.drivers,
    trips: list.extra?.facets.trips,
    flagLabel: "Not as listed",
  };

  // Each tab has its own statuses, so one chosen on the other tab goes with it.
  const pickTab = (next: "active" | "completed", status: string[] = []) => {
    setSelected(new Set());
    setFilters({ ...filters, tab: next, status });
  };

  // Off the run, for good: the driver's phone updates through the sync cursor.
  // Same rule and record as Remove… on the trip card (removeCollectionFromTrip).
  const removeCollection = async () => {
    if (!removing?.id) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/collections/${removing.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: removeReason }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRemoveError(data.error || "That collection could not be deleted");
        list.reload();
        return;
      }
      setRemoving(null);
      setRemoveReason("");
      setOpenKey(null);
      list.reload();
    } catch {
      setRemoveError("Failed to connect to server");
    } finally {
      setRemoveBusy(false);
    }
  };
  const askRemove = (r: CollectionRecord) => {
    setRemoveError(null);
    setRemoveReason("");
    setRemoving(r);
  };

  const selectable = records.filter((r) => r.rowId && awaitingCreditReview(r));
  const chosen = selectable.filter((r) => selected.has(r.rowId!));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // One at a time through the same route as a single decision, so each keeps
  // its own conditional update and audit entry; one failing stops none of the rest.
  const decideChosen = async (decision: "APPROVE" | "REJECT") => {
    setBulkBusy(true);
    setBulkNote(null);
    const failures: string[] = [];
    let done = 0;
    for (const r of chosen) {
      const error = await submitCreditDecision(r.rowId!, decision, bulkReason, bulkCharge);
      if (error) failures.push(`${r.collectionNo}: ${error}`);
      else done += 1;
    }
    setBulkBusy(false);
    setBulkRejecting(false);
    setBulkReason("");
    setBulkCharge(null);
    setSelected(new Set());
    const verb = decision === "APPROVE" ? "Approved" : "Rejected";
    setBulkNote(
      failures.length
        ? { ok: false, text: `${verb} ${done}. Not done: ${failures.join("; ")}` }
        : { ok: true, text: `${verb} ${done} for credit.` }
    );
    list.reload();
  };

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
      list.reload();
    } catch {
      setSendNote({ id, text: "Failed to connect to server", ok: false });
    } finally {
      setSendingId(null);
    }
  };

  // Rows under their day while the list runs by date; a day is only as complete
  // as the page. Any other sort has no days to group by.
  const byDay = filters.sort === "date_desc" || filters.sort === "date_asc";
  const groups: { label: string | null; rows: CollectionRecord[] }[] = [];
  for (const r of records) {
    const label = byDay ? dayLabel(r.collectedAt) : null;
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(r);
    else groups.push({ label, rows: [r] });
  }

  const summary = counts
    ? [
        {
          label: "Credits awaiting approval",
          value: counts.awaitingApproval ?? 0,
          tone: "text-[color:var(--tone-amber-fg)]",
          onClick: () => pickTab("active", ["AWAITING_APPROVAL"]),
        },
        { label: "Approved", value: counts.tabs?.approved ?? 0, tone: "text-[color:var(--tone-green-fg)]", onClick: () => pickTab("completed", ["CREDIT_APPROVED"]) },
        { label: "Items collected", value: counts.itemsCollected ?? 0, tone: "text-ink-black" },
        { label: "Receipt not emailed", value: counts.receiptNotEmailed ?? 0, tone: "text-[color:var(--tone-amber-fg)]" },
      ]
    : [];

  return (
    <div className="animate-fade-in">
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[16rem]">
          <h1 className="font-mono text-lg font-medium text-ink-black">Collections</h1>
          <p className="text-sm text-ink-muted mt-1">
            Credit returns and uplifts, across live trips and closed-out ones.
          </p>
        </div>
        <CollectionSheetUpload
          onChanged={() => {
            list.reload();
            setFolderKey((k) => k + 1);
          }}
        />
      </div>

      {/* ── Summary ─────────────────────────────────────────── */}
      {counts && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
          {summary.map((card) => {
            const body = (
              <>
                <span className={`block font-mono text-xl font-medium ${card.tone}`}>{card.value}</span>
                <span className="block text-xs text-ink-muted mt-0.5">{card.label}</span>
              </>
            );
            const box = "bg-ink-card border border-ink-border rounded px-4 py-3 text-left";
            return card.onClick ? (
              <button key={card.label} type="button" onClick={card.onClick} className={`${box} hover:border-ink-black transition-colors`}>
                {body}
              </button>
            ) : (
              <div key={card.label} className={box}>
                {body}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Active / Completed, as Trip Sheets ───────────────── */}
      <div className="bg-ink-card border border-ink-border rounded overflow-hidden">
        <StatusTabs
          active={tab}
          onChange={(id) => pickTab(id)}
          tabs={[
            { id: "active" as const, label: "Active Collections", short: "Active", count: counts?.tabs?.active ?? 0 },
            { id: "completed" as const, label: "Completed", short: "Completed", count: counts?.tabs?.completed ?? 0 },
          ]}
        />
        <RecordFilterBar
          embedded
          state={filters}
          onChange={setFilters}
          config={barConfig}
          total={list.total}
          loading={list.loading}
          exportHref={list.csvHref}
        />

      {/* ── Several at once ─────────────────────────────────── */}
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 bg-ink-black text-white">
          <span className="text-xs font-medium">{chosen.length} selected</span>
          <ChargeBoxes value={bulkCharge} onChange={setBulkCharge} disabled={bulkBusy} />
          <button type="button" onClick={() => decideChosen("APPROVE")} disabled={bulkBusy} className="act act-primary">
            {bulkBusy ? "Working…" : "Approve credits"}
          </button>
          <button type="button" onClick={() => setBulkRejecting(true)} disabled={bulkBusy} className="act !text-ink-black">
            Reject…
          </button>
          <button type="button" onClick={() => setSelected(new Set())} disabled={bulkBusy} className="ml-auto text-xs text-white/70 hover:text-white">
            Clear
          </button>
        </div>
      )}
      {bulkNote && (
        <p className={`px-4 py-2 border-b border-ink-border text-xs font-mono ${bulkNote.ok ? "text-ink-green" : "text-ink-red"}`}>{bulkNote.text}</p>
      )}
      {bulkRejecting && (
        <RejectCreditDialog
          title={`Reject ${chosen.length} collection${chosen.length === 1 ? "" : "s"} for credit`}
          reason={bulkReason}
          onReason={setBulkReason}
          charge={bulkCharge}
          onCharge={setBulkCharge}
          busy={bulkBusy}
          error={null}
          onCancel={() => setBulkRejecting(false)}
          onConfirm={() => decideChosen("REJECT")}
        />
      )}

      {/* ── Table ───────────────────────────────────────────── */}
      {list.loading && records.length === 0 ? (
        <div className="p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-ink-muted">Loading collections…</p>
        </div>
      ) : list.error && records.length === 0 ? (
        <div className="bg-ink-red-dim p-6 text-center">
          <p className="text-sm font-mono text-ink-red">{list.error}</p>
        </div>
      ) : records.length === 0 ? (
        <div className="p-12 text-center">
          <p className="font-mono text-sm text-ink-black mb-1">
            {tab === "active" ? "No active collections match" : "No completed collections match"}
          </p>
          <p className="text-xs text-ink-muted">
            Collections arrive on a trip sheet in the COLLECTNO column.
          </p>
        </div>
      ) : (
        <div>
          {/* Columns where they fit beside the sidebar; stacked below that, so a
              square monitor never scrolls the page sideways. */}
          <div className={`hidden xl:grid ${COLUMNS} gap-3 items-center px-4 py-2 text-[11px] font-mono text-ink-muted uppercase tracking-wide bg-ink-surface/50 border-b border-ink-border`}>
            <div>
              {selectable.length > 0 && (
                <input
                  type="checkbox"
                  aria-label="Select all awaiting approval on this page"
                  checked={allChosen}
                  onChange={() => setSelected(allChosen ? new Set() : new Set(selectable.map((r) => r.rowId!)))}
                  className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F]"
                />
              )}
            </div>
            <div>Collection</div>
            <div>Customer</div>
            <div>Items</div>
            <div>Reason</div>
            <div>Status</div>
            <div className="text-right">Details</div>
          </div>

          {groups.map((g, gi) => (
            <div key={`${g.label ?? "all"}-${gi}`}>
              {g.label && (
                <div className="px-4 py-1.5 bg-ink-surface/40 border-b border-ink-border text-[11px] text-ink-muted">
                  <span className="font-medium text-ink-black">{g.label}</span> · {g.rows.length} collection{g.rows.length === 1 ? "" : "s"}
                </div>
              )}
              {g.rows.map((r) => (
                <CollectionRow
                  key={recordKey(r)}
                  r={r}
                  query={filters.q}
                  checked={!!r.rowId && selected.has(r.rowId)}
                  onToggle={toggle}
                  onOpen={() => setOpenKey(recordKey(r))}
                  onChanged={list.reload}
                  onDelete={() => askRemove(r)}
                />
              ))}
            </div>
          ))}
          {list.extra?.capped && (
            <p className="px-4 py-2 border-t border-ink-border text-[11px] font-mono text-ink-muted">
              Only the newest records are searched here. Set a date range to reach older ones.
            </p>
          )}
          <Pager
            page={list.page}
            pageSize={list.pageSize}
            total={list.total ?? 0}
            onPage={list.setPage}
            onPageSize={list.setPageSize}
            disabled={list.loading}
          />
        </div>
      )}

      </div>

      <FolderPanel refreshKey={folderKey} />

      {removing && (
        <ConfirmDialog
          title={`Delete collection ${removing.collectionNo}?`}
          confirmLabel="Delete collection"
          busyLabel="Deleting…"
          busy={removeBusy}
          error={removeError}
          confirmDisabled={removeReason.trim().length < 3}
          onCancel={() => setRemoving(null)}
          onConfirm={removeCollection}
        >
          <p>
            It comes off {removing.driverName ?? "the driver"}&apos;s run for {removing.customerName} straight away. The
            removal and your reason stay on record.
          </p>
          <textarea
            value={removeReason}
            onChange={(e) => setRemoveReason(e.target.value)}
            rows={2}
            maxLength={300}
            aria-label="Reason for deleting"
            placeholder="Why it is being removed (required)"
            className="w-full px-3 py-2 text-sm text-ink-black border border-ink-border rounded focus:outline-none focus:border-ink-black resize-none"
          />
        </ConfirmDialog>
      )}

      {opened && (
        <CollectionDetail
          r={opened}
          onClose={() => setOpenKey(null)}
          onChanged={list.reload}
          onDelete={() => askRemove(opened)}
          onSend={sendReceipt}
          sending={sendingId === opened.id}
          sendNote={sendNote?.id === opened.id ? sendNote : null}
        />
      )}
    </div>
  );
}

/** Still with the driver, on a live trip: once there is an outcome it is on record. */
function canDelete(r: CollectionRecord): boolean {
  return !!r.id && !r.archived && r.status === "PENDING";
}

function recordKey(r: CollectionRecord): string {
  return `${r.tripSheetId}-${r.collectionNo}-${r.id ?? "archived"}`;
}

function dayLabel(at: string | null): string {
  if (!at) return "Not collected yet";
  return new Date(at).toLocaleDateString("en-ZA", { weekday: "short", day: "2-digit", month: "short" });
}

function itemsText(r: CollectionRecord): string | null {
  // Items against the office's sheet; the box count is not an item count.
  if (r.itemsListed != null) return r.itemsCollected != null ? `${r.itemsCollected} / ${r.itemsListed}` : `${r.itemsListed} listed`;
  if (r.collectedQty != null || r.expectedQty != null) return `${r.collectedQty ?? 0} / ${r.expectedQty ?? "—"}`;
  return null;
}

/**
 * The Reason, most useful first: what happened at the door, the lines that
 * differed (with what the office typed for them), the other lines' typed reasons
 * (once when they all say the same), and why it was rejected. So nobody has to
 * open the signed receipt to find out.
 */
function reasonEntries(r: CollectionRecord): { text: string; tone: "plain" | "amber" | "red" }[] {
  const out: { text: string; tone: "plain" | "amber" | "red" }[] = [];
  if (r.exceptionReason) out.push({ text: r.exceptionReason, tone: "amber" });
  const lines = r.reasonLines ?? [];
  for (const l of lines) {
    if (l.difference) {
      out.push({ text: `${l.item}: ${[l.sheetReason, l.difference].filter(Boolean).join(" — ")}`, tone: "amber" });
    }
  }
  const typed = lines.filter((l) => l.sheetReason && !l.difference);
  const same = typed.length > 0 && typed.every((l) => l.sheetReason === typed[0].sheetReason);
  if (same) out.push({ text: typed[0].sheetReason!, tone: "plain" });
  else for (const l of typed) out.push({ text: `${l.item}: ${l.sheetReason}`, tone: "plain" });
  if (r.creditReview === "REJECTED" && r.creditReviewReason) {
    out.push({ text: `Rejected: ${r.creditReviewReason}`, tone: "red" });
  }
  return out;
}

const TONE_CLASS = { plain: "text-ink-black", amber: "text-[color:var(--tone-amber-fg)]", red: "text-[color:var(--tone-red-fg)]" };

function CollectionRow({
  r,
  query,
  checked,
  onToggle,
  onOpen,
  onChanged,
  onDelete,
}: {
  r: CollectionRecord;
  query: string;
  checked: boolean;
  onToggle: (rowId: string) => void;
  onOpen: () => void;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const awaiting = !!r.rowId && awaitingCreditReview(r);
  const reasons = reasonEntries(r);
  const items = itemsText(r);
  const others = r.othersOnInvoice ?? 0;

  return (
    <div className="px-4 py-3 border-b border-ink-border last:border-0 hover:bg-ink-surface/30 transition-colors">
      <div className={`grid grid-cols-[1.25rem_minmax(0,1fr)] sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 ${COLUMNS} xl:gap-y-2 xl:items-start`}>
        <div className="row-span-6 sm:row-span-4 xl:row-span-1 pt-1">
          {awaiting && (
            <input
              type="checkbox"
              aria-label={`Select collection ${r.collectionNo}`}
              checked={checked}
              onChange={() => onToggle(r.rowId!)}
              className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F]"
            />
          )}
        </div>

        <div className="min-w-0 sm:col-start-2 sm:row-start-1 xl:col-start-auto xl:row-start-auto">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button type="button" onClick={onOpen} aria-label={`Open collection ${r.collectionNo}`}>
              <DocChip kind={collectionKind(r)} number={r.collectionNo} tone={collectionTone(r.status)} />
            </button>
            {r.archived && (
              <StatusBadge tone="idle" title="This trip has been closed out — read from the archive">
                Archived
              </StatusBadge>
            )}
          </div>
          {r.originalInvoiceNo && (
            <p className="text-[11px] font-mono text-ink-muted mt-1">
              INV {r.originalInvoiceNo}
              {others > 0 && (
                <span className="text-[color:var(--tone-amber-fg)]"> · {others + 1} on this invoice</span>
              )}
            </p>
          )}
          {r.upliftSubtype && <p className="text-[11px] text-ink-muted mt-1">{SUBTYPE_LABEL[r.upliftSubtype] ?? r.upliftSubtype}</p>}
        </div>

        <button type="button" onClick={onOpen} className="min-w-0 text-left group sm:col-start-2 sm:row-start-2 xl:col-start-auto xl:row-start-auto">
          <span className="block text-[13px] text-ink-black group-hover:underline"><Highlight text={r.customerName} query={query} /></span>
          <span className="block text-[11px] font-mono text-ink-muted">
            {r.driverName ?? "No driver"}
            {r.tripDate && <span className="whitespace-nowrap"> · trip {r.tripDate}</span>}
            {RECEIPT_STATUSES.has(r.status) && r.emailStatus && (
              <span className={EMAIL_LABEL[r.emailStatus]?.tone ?? ""} title={r.emailError ?? undefined}>
                {" "}· {EMAIL_LABEL[r.emailStatus]?.text ?? r.emailStatus}
              </span>
            )}
          </span>
        </button>

        <div className={`text-[13px] font-mono text-ink-black min-w-0 sm:col-start-2 sm:row-start-3 xl:col-start-auto xl:row-start-auto ${items || r.hasVariance ? "" : "hidden xl:block"}`}>
          {items ? <span><span className="xl:hidden text-[11px] text-ink-muted">Items </span>{items}</span> : <span className="hidden xl:inline text-ink-muted">—</span>}
          {r.hasVariance && <span className="inline xl:block ml-2 xl:ml-0 text-[11px] text-[color:var(--tone-amber-fg)]">not as listed</span>}
        </div>

        <div className={`min-w-0 text-[12px] leading-snug sm:col-start-2 sm:col-span-2 sm:row-start-4 xl:col-start-auto xl:col-span-1 xl:row-start-auto ${reasons.length ? "" : "hidden xl:block"}`}>
          {reasons.length === 0 ? (
            <span className="hidden xl:inline text-ink-muted">—</span>
          ) : (
            <>
              {reasons.slice(0, REASONS_SHOWN).map((e, i) => (
                <p key={i} className={`break-words ${TONE_CLASS[e.tone]}`}>
                  <span className="xl:hidden text-[11px] text-ink-muted">{i === 0 ? "Reason " : ""}</span>
                  {e.text}
                </p>
              ))}
              {reasons.length > REASONS_SHOWN && (
                <button type="button" onClick={onOpen} className="text-[11px] text-ink-muted underline hover:text-ink-black">
                  +{reasons.length - REASONS_SHOWN} more
                </button>
              )}
            </>
          )}
        </div>

        <div className="min-w-0 flex flex-col items-start gap-1 sm:col-start-3 sm:row-start-1 sm:items-end xl:col-start-auto xl:row-start-auto xl:items-start">
          {creditReviewRequired(r) ? (
            <CreditBadge review={r.creditReview} reason={r.creditReviewReason} by={r.creditReviewedBy} />
          ) : (
            <StatusBadge tone={collectionTone(r.status)} dot>
              {STATUS_LABEL[r.status] ?? r.status}
            </StatusBadge>
          )}
          {creditReviewRequired(r) && r.status === "PARTIAL" && (
            <StatusBadge tone={collectionTone(r.status)}>{STATUS_LABEL[r.status]}</StatusBadge>
          )}
          {r.creditCharge && <span className="text-[11px] text-ink-muted">{CREDIT_CHARGE_LABEL[r.creditCharge]}</span>}
        </div>

        <div className="flex flex-wrap gap-1.5 sm:col-start-3 sm:row-start-2 sm:row-span-2 sm:justify-end sm:items-start xl:col-start-auto xl:row-start-auto xl:row-span-1">
          <button type="button" onClick={onOpen} className="act" aria-label={`Details of collection ${r.collectionNo}`}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            Details
          </button>
          {canDelete(r) && (
            <button type="button" onClick={onDelete} className="act act-danger" aria-label={`Delete collection ${r.collectionNo}`}>
              Delete
            </button>
          )}
        </div>
      </div>

      {/* The office's decision on a credit return that came back — made here,
          before or after its trip closes. Accounts makes the credit note once
          it is approved. */}
      {awaiting && (
        <div className="mt-2 flex items-center gap-x-3 gap-y-2 flex-wrap rounded-md bg-ink-surface/60 px-2 py-1.5">
          <span className="text-[11px] font-mono text-ink-muted">Credit</span>
          <CreditReviewControl
            hideBadge
            collection={{
              id: r.rowId!,
              collectionNo: r.collectionNo,
              creditReview: r.creditReview ?? null,
              creditReviewReason: r.creditReviewReason ?? null,
              creditReviewedBy: r.creditReviewedBy ?? null,
              creditCharge: r.creditCharge ?? null,
            }}
            onChanged={onChanged}
          />
        </div>
      )}
    </div>
  );
}

/** One collection: why, the chain, its documents, the receipt and the decision. */
function CollectionDetail({
  r,
  onClose,
  onChanged,
  onDelete,
  onSend,
  sending,
  sendNote,
}: {
  r: CollectionRecord;
  onClose: () => void;
  onChanged: () => void;
  onDelete: () => void;
  onSend: (id: string) => void;
  sending: boolean;
  sendNote: { text: string; ok: boolean } | null;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A confirmation open on top takes its own Cancel first.
      if (e.key === "Escape" && !document.querySelector("[role=alertdialog]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reasonLines = r.reasonLines ?? [];
  const others = r.othersOnInvoice ?? 0;
  const items = itemsText(r);
  const reviewable = creditReviewRequired(r);
  const heading = "text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-2";

  // On the page body: a transformed ancestor would pin it to the card instead.
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 animate-fade-in" onClick={onClose}>
      <aside
        role="dialog"
        aria-label={`Collection ${r.collectionNo}`}
        className="w-full max-w-md h-full overflow-y-auto bg-ink-card shadow-xl px-6 py-6 space-y-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <DocChip kind={collectionKind(r)} number={r.collectionNo} tone={collectionTone(r.status)} />
            <h2 className="mt-2 text-base font-medium text-ink-black">{r.customerName}</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              {r.driverName ?? "No driver"}
              {r.tripDate ? ` · trip ${r.tripDate}` : ""}
            </p>
          </div>
          <button type="button" autoFocus onClick={onClose} className="act" aria-label="Close details">
            Close
          </button>
        </div>

        {others > 0 && r.originalInvoiceNo && (
          <p className="rounded border border-[color:var(--tone-amber-fg)]/25 bg-ink-amber-dim px-3 py-2 text-xs text-[color:var(--tone-amber-fg)]">
            {others === 1 ? "Another collection is" : `${others} other collections are`} logged against INV {r.originalInvoiceNo}. Check before approving so the credit isn&apos;t doubled.
          </p>
        )}

        <section>
          <h3 className={heading}>Reason</h3>
          {r.exceptionReason && <p className="text-sm text-[color:var(--tone-amber-fg)] mb-2 break-words">{r.exceptionReason}</p>}
          {reasonLines.length > 0 ? (
            <ul className="divide-y divide-ink-border border border-ink-border rounded">
              {reasonLines.map((l, i) => (
                <li key={i} className="px-3 py-2 text-xs">
                  <p className="font-mono text-ink-black">{l.item}</p>
                  {l.description !== l.item && <p className="text-ink-muted">{l.description}</p>}
                  {l.sheetReason && <p className="mt-1 text-ink-black break-words">{l.sheetReason}</p>}
                  {l.difference && <p className="mt-1 text-[color:var(--tone-amber-fg)] break-words">{l.difference}</p>}
                </li>
              ))}
            </ul>
          ) : (
            !r.exceptionReason && <p className="text-xs text-ink-muted">No reason on the sheet, and nothing differed.</p>
          )}
          {r.creditReview === "REJECTED" && r.creditReviewReason && (
            <p className="text-sm text-[color:var(--tone-red-fg)] mt-2 break-words">Rejected: {r.creditReviewReason}</p>
          )}
        </section>

        <section>
          <h3 className={heading}>Invoice chain</h3>
          <ol className="space-y-3 text-sm">
            {r.originalInvoiceNo && (
              <li>
                <p className="text-ink-black">Invoice {r.originalInvoiceNo}</p>
                <p className="text-xs text-ink-muted">Original sale</p>
              </li>
            )}
            <li>
              <p className="text-ink-black">
                {STATUS_LABEL[r.status]}
                {items ? ` · ${items}` : ""}
              </p>
              <p className="text-xs text-ink-muted">
                {r.signedByName ? `Signed by ${r.signedByName}` : "No signature"}
                {r.collectedAt
                  ? ` · ${new Date(r.collectedAt).toLocaleDateString("en-ZA", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}`
                  : ""}
              </p>
            </li>
            {reviewable && (
              <li>
                <CreditBadge review={r.creditReview} reason={r.creditReviewReason} by={r.creditReviewedBy} />
                <p className="text-xs text-ink-muted mt-1">
                  {r.creditReviewedBy ? `By ${r.creditReviewedBy}` : "Accounts makes the credit note once this is approved"}
                  {r.creditCharge ? ` · ${CREDIT_CHARGE_LABEL[r.creditCharge]}` : ""}
                </p>
              </li>
            )}
          </ol>
        </section>

        <section>
          <h3 className={heading}>Documents</h3>
          <div className="flex flex-wrap gap-2">
            {r.signedFilePath ? (
              <a
                href={`/api/collections/document/${encodeURIComponent(r.signedFilePath)}?signed=true`}
                target="_blank"
                rel="noreferrer"
                className="act"
              >
                Signed receipt
              </a>
            ) : (
              <StatusBadge tone="idle">No receipt</StatusBadge>
            )}
            {/* The invoice it is credited against, the whole chain. */}
            {r.invoiceId && (
              <Link href={`/invoices/${r.invoiceId}`} className="act" title="Delivery, collections and credit notes for this invoice">
                Invoice chain
              </Link>
            )}
            {/* Only when there is a sheet to open (as on the trip card). A live
                one is fetched by id; an archived one has no row left, so it
                needs the filename frozen with it. */}
            {r.sourceFilePath && (
              <a
                href={r.id ? `/api/collections/${r.id}/source` : `/api/collections/document/${encodeURIComponent(r.sourceFilePath)}`}
                target="_blank"
                rel="noreferrer"
                className="act"
              >
                Office sheet
              </a>
            )}
          </div>
        </section>

        {RECEIPT_STATUSES.has(r.status) && (
          <section>
            <h3 className={heading}>Customer receipt</h3>
            <div className="flex flex-wrap items-center gap-2">
              {r.emailStatus && (
                <span className={`text-sm ${EMAIL_LABEL[r.emailStatus]?.tone ?? "text-ink-muted"}`} title={r.emailError ?? undefined}>
                  {EMAIL_LABEL[r.emailStatus]?.text ?? r.emailStatus}
                </span>
              )}
              {/* Only for a receipt that did not go out: the email is sent when
                  the driver confirms, and this is the fallback. */}
              {r.id && r.emailStatus !== "SENT" && (
                <button
                  type="button"
                  onClick={() => onSend(r.id!)}
                  disabled={sending || r.emailStatus === "SENDING"}
                  className={`act ${r.emailStatus === "FAILED" ? "act-red" : ""}`}
                  title="Email the signed receipt to the customer"
                >
                  {sending ? "Sending…" : r.emailStatus === "FAILED" ? "Retry email" : "Send email"}
                </button>
              )}
              {r.emailStatus === "NO_EMAIL" && (
                <Link href="/contacts" className="act">
                  Add contact
                </Link>
              )}
            </div>
            {sendNote && (
              <p className={`text-[11px] font-mono mt-1 ${sendNote.ok ? "text-ink-green" : "text-ink-amber"}`}>{sendNote.text}</p>
            )}
          </section>
        )}

        {/* A decision with no row to act on (very old archive). */}
        {reviewable && r.rowId && (
          <section>
            <h3 className={heading}>Credit decision</h3>
            <div className="flex items-center gap-2 flex-wrap">
              <CreditReviewControl
                hideBadge
                collection={{
                  id: r.rowId,
                  collectionNo: r.collectionNo,
                  creditReview: r.creditReview ?? null,
                  creditReviewReason: r.creditReviewReason ?? null,
                  creditReviewedBy: r.creditReviewedBy ?? null,
                  creditCharge: r.creditCharge ?? null,
                }}
                onChanged={onChanged}
              />
            </div>
          </section>
        )}

        {canDelete(r) && (
          <section>
            <button type="button" onClick={onDelete} className="act act-danger">
              Delete collection
            </button>
          </section>
        )}
      </aside>
    </div>,
    document.body
  );
}
