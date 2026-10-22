"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";

import RecordFilterBar, { Highlight, type FilterBarConfig } from "@/components/admin/RecordFilterBar";
import { DocChip, StatusBadge } from "@/components/ui/Chips";
import { applyFilter, toCsv, type FilterAccessors, type FilterState } from "@/lib/record-filter";
import { useRecordFilters } from "@/hooks/useRecordFilters";

interface InvoiceFile {
  name: string;
  filename: string;
  sizeBytes: number;
  lastModified: string;
  invoiceNumber: string;
  isSigned: boolean;
  signedAt?: string;
  /** The invoice registry row behind this file — what a hand correction edits. */
  recordId: string | null;
  /** The invoice's own date (YYYY-MM-DD), read off the PDF. Not the trip date. */
  invoiceDate: string | null;
  /** The trip sheet's CUSTOMER, else the PDF's Deliver to. */
  customerName: string | null;
  pdfCustomerName: string | null;
  /** The trip sheet's customer matches neither name on the PDF. */
  customerMismatch: boolean;
  headerSource: string | null;
  headerError: string | null;
  /** Where the invoice's chain stands (lib/invoice-chain.ts). */
  chainStatus: string | null;
  chainLabel: string | null;
  /** On a courier trip sheet — it goes by courier, not with one of our drivers. */
  courier?: { id: string; courierSheetNo: string; status: string } | null;
}

/** The chain status tints, as on the invoice page. */
const CHAIN_TONE: Record<string, "idle" | "green" | "amber" | "violet" | "red" | "blue"> = {
  NOT_DELIVERED: "idle",
  DELIVERED: "green",
  COLLECTION_PENDING: "amber",
  AWAITING_CREDIT: "violet",
  PARTIALLY_CREDITED: "amber",
  FULLY_CREDITED: "blue",
  EXCEPTION: "red",
};

const CHAIN_OPTIONS = [
  { value: "NOT_DELIVERED", label: "Not delivered" },
  { value: "DELIVERED", label: "Delivered" },
  { value: "COLLECTION_PENDING", label: "Collection pending" },
  { value: "AWAITING_CREDIT", label: "Awaiting credit" },
  { value: "PARTIALLY_CREDITED", label: "Partially credited" },
  { value: "FULLY_CREDITED", label: "Fully credited" },
  { value: "EXCEPTION", label: "Exception" },
];

/** Past delivered, every chain status means a credit collection hangs off the invoice. */
const NO_COLLECTION = new Set(["NOT_DELIVERED", "DELIVERED"]);

/**
 * The Invoices tab runs the shared filter rulebook in the browser, not on the
 * server: its list is the invoice folder, listed over Microsoft Graph on every
 * request, so a round trip per filter change would re-list the folder each
 * time. The whole listing already arrives in one response.
 */
const INVOICE_FILTER: FilterAccessors<InvoiceFile> = {
  search: (inv) => [inv.invoiceNumber, inv.filename, inv.name, inv.customerName, inv.pdfCustomerName, formatInvoiceDate(inv.invoiceDate)],
  date: (inv) => inv.invoiceDate,
  status: (inv) => inv.chainStatus ?? "NOT_DELIVERED",
  customer: (inv) => inv.customerName,
  flag: (inv) => !!inv.chainStatus && !NO_COLLECTION.has(inv.chainStatus),
  number: (inv) => inv.invoiceNumber,
};

/** DD/MM/YYYY, as the trip sheets write it. */
function formatInvoiceDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

interface DuplicateGroup {
  invoiceNumber: string;
  filenames: string[];
}

/** A live stop that uses an invoice — see findInvoiceTripUsage. */
interface TripUsage {
  filename: string;
  stopId: string;
  driverName: string;
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  status: string;
}

interface InvoiceData {
  folder: string;
  count: number;
  signedCount: number;
  unsignedCount: number;
  invoices: InvoiceFile[];
  duplicates?: DuplicateGroup[];
}

export default function InvoicesPage() {
  const [data, setData] = useState<InvoiceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"ALL" | "SIGNED" | "UNSIGNED">("ALL");
  /** Search and filters over the folder listing — see lib/record-filter.ts. */
  const [filters, setFiltersState] = useRecordFilters("invoices");
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 20;

  // Selection state
  const [selectedInvoices, setSelectedInvoices] = useState<Set<string>>(new Set());
  const [deletingInvoices, setDeletingInvoices] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteMode, setDeleteMode] = useState<"original_only" | "both">("both");
  const [syncing, setSyncing] = useState(false);

  // Which live trip sheets use the selected invoices — read when the delete
  // dialog opens, so the warning names the drivers and stops it will affect.
  const [tripUsage, setTripUsage] = useState<TripUsage[] | null>(null);
  const [tripUsageFailed, setTripUsageFailed] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  /** What the last delete took off live runs, shown once it is done. */
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  // Hand correction of an invoice's date / customer (PATCH /api/invoice-records).
  const [editing, setEditing] = useState<{
    inv: InvoiceFile;
    date: string;
    customer: string;
    saving: boolean;
    error: string | null;
  } | null>(null);

  const saveEdit = async () => {
    if (!editing?.inv.recordId) return;
    setEditing({ ...editing, saving: true, error: null });
    try {
      const res = await fetch(`/api/invoice-records/${encodeURIComponent(editing.inv.recordId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceDate: editing.date || null, customerName: editing.customer }),
      });
      const json = await res.json();
      if (!res.ok) {
        setEditing({ ...editing, saving: false, error: json.error || "Failed to save" });
        return;
      }
      // Every file of this invoice shares the record (IV-365-4 and IV-365-5).
      setData((prev) =>
        prev && {
          ...prev,
          invoices: prev.invoices.map((i) =>
            i.recordId === editing.inv.recordId
              ? {
                  ...i,
                  invoiceDate: json.invoiceDate,
                  customerName: json.customerName ?? i.pdfCustomerName,
                  headerSource: "MANUAL",
                  headerError: null,
                }
              : i
          ),
        }
      );
      setEditing(null);
    } catch {
      setEditing({ ...editing, saving: false, error: "Network error" });
    }
  };

  // Upload — files land in the same folder this page lists, so a PDF added
  // here is immediately available to match against a trip sheet.
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResults, setUploadResults] = useState<
    { name: string; ok: boolean; message: string }[]
  >([]);

  const fetchInvoices = useCallback(() => {
    setLoading(true);
    fetch("/api/invoices")
      .then((res) => res.json())
      .then((json) => {
        if (json.error) {
          setError(json.error);
        } else {
          setData(json);
        }
      })
      .catch(() => setError("Failed to connect to server"))
      .finally(() => setLoading(false));
  }, []);

  const syncInvoices = useCallback(() => {
    setSyncing(true);
    setError(null);
    fetch("/api/invoices")
      .then((res) => res.json())
      .then((json) => {
        if (json.error) {
          setError(json.error);
        } else {
          setData(json);
          setSelectedInvoices(new Set());
        }
      })
      .catch(() => setError("Failed to connect to server"))
      .finally(() => setSyncing(false));
  }, []);

  /**
   * Send PDFs to the invoice folder, one request each.
   *
   * Sequential rather than parallel: this is a handful of files at a time, and
   * a serial run keeps the per-file result honest — a name clash on one file
   * must not read as a failure of the batch.
   */
  const handleUploadInvoices = async (files: File[]) => {
    setUploading(true);
    setUploadResults([]);

    const results: { name: string; ok: boolean; message: string }[] = [];
    for (const file of files) {
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await fetch("/api/invoices/upload", { method: "POST", body: formData });
        const json = await res.json();
        results.push(
          res.ok
            ? { name: file.name, ok: true, message: `saved as ${json.filename}` }
            : { name: file.name, ok: false, message: json.error || "Upload failed" }
        );
      } catch {
        results.push({ name: file.name, ok: false, message: "Upload failed" });
      }
    }

    setUploadResults(results);
    setUploading(false);
    syncInvoices();
  };

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-ZA", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // The pills come first and the search box narrows what they left, so the
  // readout beside the field counts against the pill in force rather than
  // against the whole folder.
  const statusFiltered = useMemo(
    () =>
      data?.invoices.filter((inv) => {
        if (filter === "SIGNED") return inv.isSigned;
        if (filter === "UNSIGNED") return !inv.isSigned;
        return true;
      }) ?? [],
    [data, filter]
  );

  const filteredInvoices = useMemo(() => applyFilter(statusFiltered, filters, INVOICE_FILTER), [statusFiltered, filters]);
  const filtersOn = filteredInvoices.length !== statusFiltered.length;
  const customers = useMemo(
    () => [...new Set((data?.invoices ?? []).map((i) => i.customerName).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)),
    [data]
  );
  const barConfig: FilterBarConfig = {
    searchPlaceholder: "Invoice no, customer, filename…",
    noun: "invoice",
    dateLabel: "Invoice date",
    statusOptions: CHAIN_OPTIONS,
    sortOptions: [
      { value: "date_desc", label: "Newest first" },
      { value: "date_asc", label: "Oldest first" },
      { value: "customer", label: "Customer A–Z" },
      { value: "number", label: "Invoice no" },
      { value: "status", label: "Status" },
    ],
    customers,
    flagLabel: "Has a credit collection",
  };

  const exportCsv = () => {
    const csv = toCsv(
      ["Invoice No", "Invoice date", "Customer", "Status", "Signed", "Signed at", "File"],
      filteredInvoices.map((inv) => [
        inv.invoiceNumber,
        inv.invoiceDate,
        inv.customerName,
        inv.chainLabel,
        inv.isSigned ? "Yes" : "No",
        inv.signedAt ?? "",
        inv.filename,
      ])
    );
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `signex-invoices-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredInvoices.length / ITEMS_PER_PAGE));
  const paginatedInvoices = filteredInvoices.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE
  );

  // Reset to page 1 when filter changes
  const handleFilterChange = (f: "ALL" | "SIGNED" | "UNSIGNED") => {
    setFilter(f);
    setCurrentPage(1);
    setSelectedInvoices(new Set());
  };

  /**
   * Narrowing the list drops the selection with it, exactly as the pills do.
   * Otherwise Delete Selected would still be holding rows the query has since
   * hidden, which is not what the count in the action bar implies.
   */
  const setFilters = (next: FilterState) => {
    setFiltersState(next);
    setCurrentPage(1);
    setSelectedInvoices(new Set());
  };

  const filterCounts = {
    ALL: data?.count ?? 0,
    SIGNED: data?.signedCount ?? 0,
    UNSIGNED: data?.unsignedCount ?? 0,
  };

  // ─── Selection helpers ─────────────────────────────────────────────
  const toggleInvoice = (filename: string) => {
    setSelectedInvoices((prev) => {
      const next = new Set(prev);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const toggleAllInvoices = () => {
    const allFilenames = filteredInvoices.map((i) => i.filename);
    if (selectedInvoices.size === allFilenames.length) {
      setSelectedInvoices(new Set());
    } else {
      setSelectedInvoices(new Set(allFilenames));
    }
  };

  const selectDuplicateInvoices = () => {
    if (!data?.duplicates) return;
    const dupeFiles = new Set<string>();
    for (const group of data.duplicates) {
      // Select all except the first (keep one, select the rest)
      for (let i = 1; i < group.filenames.length; i++) {
        dupeFiles.add(group.filenames[i]);
      }
    }
    // Show what was just selected: a live query would otherwise leave most of
    // it off-screen while the action bar counted it.
    setFiltersState({ ...filters, q: "", status: [], from: "", to: "", preset: "", customer: "", flag: false });
    setCurrentPage(1);
    setSelectedInvoices(dupeFiles);
  };

  const openDeleteConfirm = async () => {
    setShowDeleteConfirm(true);
    setTripUsage(null);
    setTripUsageFailed(false);
    setDeleteReason("");
    setDeleteNotice(null);
    try {
      const res = await fetch("/api/invoices/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames: Array.from(selectedInvoices) }),
      });
      if (!res.ok) throw new Error();
      const json = await res.json();
      setTripUsage(json.usage ?? []);
    } catch {
      // The server removes affected stops either way; the warning just could
      // not name them.
      setTripUsageFailed(true);
      setTripUsage([]);
    }
  };

  const closeDeleteConfirm = () => {
    setShowDeleteConfirm(false);
    setDeleteMode("both");
    setTripUsage(null);
  };

  const handleBatchDeleteInvoices = async () => {
    if (selectedInvoices.size === 0) return;
    setDeletingInvoices(true);
    setError(null);
    try {
      const res = await fetch("/api/invoices", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filenames: Array.from(selectedInvoices),
          mode: deleteMode,
          reason: deleteReason,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        setError(result.error || "Failed to delete invoices");
      } else {
        const removed: TripUsage[] = result.removedStops ?? [];
        if (removed.length > 0) {
          setDeleteNotice(
            `Removed from active trip sheets: ${removed
              .map((u) => `${u.invoiceNumber} (${u.driverName}, stop ${u.stopNumber})`)
              .join(", ")}`
          );
        }
        setSelectedInvoices(new Set());
        syncInvoices();
      }
    } catch {
      setError("Failed to delete invoices");
    } finally {
      setDeletingInvoices(false);
      closeDeleteConfirm();
    }
  };

  const usageUnsigned = (tripUsage ?? []).filter((u) => u.status !== "SIGNED");
  const usageSigned = (tripUsage ?? []).filter((u) => u.status === "SIGNED");

  // Duplicate filename set for quick lookup
  const duplicateFilenames = new Set<string>();
  if (data?.duplicates) {
    for (const group of data.duplicates) {
      for (const fn of group.filenames) {
        duplicateFilenames.add(fn);
      }
    }
  }

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-8 gap-4">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="font-mono text-2xl font-medium text-ink-black tracking-tight">
              Invoices
            </h1>
            <p className="text-sm text-ink-muted mt-1">
              {loading
                ? "Loading…"
                : error
                ? "Error loading invoices"
                : `${data?.count ?? 0} invoices in local folder`}
            </p>
          </div>
          <button
            onClick={syncInvoices}
            disabled={syncing || loading}
            title="Sync from folder"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-ink-muted bg-ink-card border border-ink-border rounded hover:text-ink-black hover:border-ink-black/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={syncing ? "animate-spin" : ""}>
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            {syncing ? "Syncing…" : "Sync"}
          </button>
          <input
            ref={uploadInputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              // Cleared so re-picking the same file still fires onChange.
              e.target.value = "";
              if (files.length > 0) handleUploadInvoices(files);
            }}
          />
          <button
            onClick={() => uploadInputRef.current?.click()}
            disabled={uploading || loading}
            title="Add invoice PDFs to the folder above"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono text-ink-muted bg-ink-card border border-ink-border rounded hover:text-ink-black hover:border-ink-black/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
        {/* Filter pills */}
        <div className="flex gap-1 bg-ink-card border border-ink-border rounded p-0.5">
          {(["ALL", "SIGNED", "UNSIGNED"] as const).map((f) => {
            const isActive = filter === f;
            const btnClass = [
              "px-3 py-1.5 text-xs font-mono rounded transition-colors flex items-center gap-1.5",
              isActive ? "bg-ink-black text-white" : "text-ink-muted hover:text-ink-black",
            ].join(" ");
            const countClass = [
              "text-[10px]",
              isActive ? "text-white/60" : "text-ink-muted",
            ].join(" ");
            return (
              <button
                key={f}
                onClick={() => handleFilterChange(f)}
                className={btnClass}
              >
                {f === "ALL" ? "All" : f === "SIGNED" ? "Signed" : "Unsigned"}
                <span className={countClass}>
                  {filterCounts[f]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Folder path indicator */}
      {data?.folder && (
        <div className="flex items-center gap-2 mb-4 px-4 py-2.5 bg-ink-card border border-ink-border rounded">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-ink-muted shrink-0">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="text-xs font-mono text-ink-muted truncate">{data.folder}</span>
        </div>
      )}

      {/* Upload results — per file, since a name clash on one is not a failure
          of the batch. */}
      {uploadResults.length > 0 && (
        <div className="mb-4 px-4 py-3 bg-ink-card border border-ink-border rounded space-y-1">
          <div className="flex items-center justify-between mb-1">
            <p className="text-xs font-mono text-ink-muted">
              Uploaded {uploadResults.filter((r) => r.ok).length} of {uploadResults.length}
            </p>
            <button
              onClick={() => setUploadResults([])}
              className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
            >
              Dismiss
            </button>
          </div>
          {uploadResults.map((r) => (
            <p key={r.name} className="text-[11px] font-mono flex items-center gap-2">
              <span className="text-ink-muted truncate max-w-[280px]">{r.name}</span>
              <span className={r.ok ? "text-ink-green" : "text-ink-red"}>{r.message}</span>
            </p>
          ))}
        </div>
      )}

      {/* Duplicate warning banner */}
      {data?.duplicates && data.duplicates.length > 0 && (
        <div className="flex items-center gap-3 mb-4 px-4 py-2.5 bg-ink-amber-dim border border-ink-amber/20 rounded">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-amber shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <p className="text-xs font-mono text-ink-amber flex-1">
            {data.duplicates.length} duplicate group{data.duplicates.length !== 1 ? "s" : ""} detected — {data.duplicates.reduce((sum, g) => sum + g.filenames.length - 1, 0)} duplicate files
          </p>
          <button
            onClick={selectDuplicateInvoices}
            className="flex items-center gap-1.5 px-3 py-1 text-[11px] font-mono font-medium text-ink-amber bg-white/60 border border-ink-amber/20 rounded hover:bg-white hover:border-ink-amber/40 transition-all"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 11 12 14 22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
            Select Duplicates
          </button>
        </div>
      )}

      {/* Search toolbar. Rendered above the empty state as well as the table —
          a query that matches nothing would otherwise take its own clear
          button off the page with it. */}
      {!loading && !error && data && data.count > 0 && (
        <div className="mb-4">
          <RecordFilterBar
            state={filters}
            onChange={setFilters}
            config={barConfig}
            total={filteredInvoices.length}
            onExport={exportCsv}
          />
        </div>
      )}

      {/* Error state */}
      {deleteNotice && (
        <div className="flex items-start justify-between gap-3 bg-ink-amber-dim border border-ink-amber/20 rounded px-4 py-3">
          <p className="text-xs font-mono text-ink-amber">
            {deleteNotice}. The drivers&apos; runs have been updated —{" "}
            <Link href="/trip-sheet" className="underline">see Trip Sheets</Link>.
          </p>
          <button
            onClick={() => setDeleteNotice(null)}
            className="text-xs font-mono text-ink-muted hover:text-ink-black shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="bg-ink-red-dim border border-ink-red/20 rounded p-6 text-center">
          <p className="text-sm font-mono text-ink-red mb-2">{error}</p>
          <p className="text-xs text-ink-muted">
            Go to <Link href="/settings" className="text-[#0078D4] underline">Settings</Link> and choose an invoice folder via OneDrive, or set a local folder path.
          </p>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-ink-muted">Scanning invoice folder…</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && data?.count === 0 && (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <div className="text-4xl mb-4">📂</div>
          <p className="font-mono text-sm font-medium text-ink-black mb-2">No invoices found</p>
          <p className="text-xs text-ink-muted max-w-sm mx-auto">
            Drop PDF invoice files into your configured folder to see them here.
            The default folder is <code className="font-mono bg-ink-surface px-1 py-0.5 rounded">./invoices</code> in the project root.
          </p>
        </div>
      )}

      {/* Filtered empty state */}
      {!loading && !error && data && data.count > 0 && filteredInvoices.length === 0 && (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <div className="text-4xl mb-4">
            {filtersOn ? "🔍" : filter === "SIGNED" ? "✍️" : "📋"}
          </div>
          {filtersOn ? (
            <>
              <p className="font-mono text-sm font-medium text-ink-black mb-2">
                {filters.q.trim() ? <>Nothing matches “{filters.q.trim()}”</> : "Nothing matches these filters"}
              </p>
              <p className="text-xs text-ink-muted max-w-sm mx-auto">
                {filter === "ALL"
                  ? "No invoice in this folder fits the search and filters."
                  : `No ${filter.toLowerCase()} invoice matches — try the All pill above.`}
              </p>
              <button
                onClick={() => setFilters({ ...filters, q: "", status: [], from: "", to: "", preset: "", customer: "", flag: false })}
                className="mt-4 px-3 py-1.5 text-xs font-mono text-ink-muted bg-ink-surface border border-ink-border rounded hover:text-ink-black hover:border-ink-black/30 transition-all"
              >
                Clear search and filters
              </button>
            </>
          ) : (
            <>
              <p className="font-mono text-sm font-medium text-ink-black mb-2">
                No {filter.toLowerCase()} invoices
              </p>
              <p className="text-xs text-ink-muted max-w-sm mx-auto">
                {filter === "SIGNED"
                  ? "No invoices have been signed yet. Drivers will sign invoices during deliveries."
                  : "All invoices have been signed."}
              </p>
            </>
          )}
        </div>
      )}

      {/* Invoice table */}
      {!loading && !error && filteredInvoices.length > 0 && (
        <div className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-border">
                  <th className="text-left px-5 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={filteredInvoices.length > 0 && selectedInvoices.size === filteredInvoices.length}
                      onChange={toggleAllInvoices}
                      className="w-3.5 h-3.5 rounded border-ink-border text-ink-green accent-[#00C07F] cursor-pointer"
                    />
                  </th>
                  <th className="text-left px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide">
                    Invoice
                  </th>
                  <th className="text-left px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide whitespace-nowrap">
                    Invoice Date
                  </th>
                  <th className="text-left px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide">
                    Customer
                  </th>
                  <th className="text-left px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide">
                    Status
                  </th>
                  <th className="text-left px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide hidden md:table-cell">
                    Filename
                  </th>
                  <th className="text-left px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide hidden sm:table-cell">
                    Size
                  </th>
                  <th className="text-right px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide hidden sm:table-cell">
                    Modified
                  </th>
                  <th className="text-right px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-border">
                {paginatedInvoices.map((inv) => (
                  <tr
                    key={inv.filename}
                    className={`hover:bg-ink-surface/50 transition-colors ${
                      duplicateFilenames.has(inv.filename) ? "bg-ink-amber-dim/30" : ""
                    } ${selectedInvoices.has(inv.filename) ? "bg-ink-green-dim/20" : ""}`}
                  >
                    <td className="px-5 py-3.5 w-10">
                      <input
                        type="checkbox"
                        checked={selectedInvoices.has(inv.filename)}
                        onChange={() => toggleInvoice(inv.filename)}
                        className="w-3.5 h-3.5 rounded border-ink-border text-ink-green accent-[#00C07F] cursor-pointer"
                      />
                    </td>
                    <td className="px-5 py-3.5 font-mono font-medium text-ink-black">
                      <div className="flex items-center gap-2">
                        <DocChip kind="INV" number={inv.invoiceNumber} tone={inv.isSigned ? "green" : "idle"} />
                        {duplicateFilenames.has(inv.filename) && <StatusBadge tone="amber">Duplicate</StatusBadge>}
                      </div>
                    </td>
                    <td
                      className="px-5 py-3.5 font-mono text-xs text-ink-black whitespace-nowrap"
                      title={
                        inv.invoiceDate
                          ? inv.headerSource === "MANUAL"
                            ? "Entered by hand"
                            : "Read from the invoice PDF"
                          : inv.headerError ?? "Not read from the PDF yet"
                      }
                    >
                      {formatInvoiceDate(inv.invoiceDate)}
                    </td>
                    <td className="px-5 py-3.5 text-xs text-ink-black">
                      <div className="flex items-center gap-1.5 max-w-[220px]">
                        <span className="truncate" title={inv.customerName ?? undefined}>
                          {inv.customerName ? <Highlight text={inv.customerName} query={filters.q} /> : "—"}
                        </span>
                        {inv.customerMismatch && (
                          <span
                            className="shrink-0 inline-flex items-center justify-center w-4 h-4 text-[10px] font-mono font-bold rounded-full bg-ink-amber-dim text-ink-amber"
                            title={`The invoice PDF names ${inv.pdfCustomerName ?? "a different customer"}`}
                          >
                            !
                          </span>
                        )}
                        {inv.recordId && (
                          <button
                            onClick={() =>
                              setEditing({
                                inv,
                                date: inv.invoiceDate ?? "",
                                customer: inv.customerName ?? "",
                                saving: false,
                                error: null,
                              })
                            }
                            className="shrink-0 text-ink-muted hover:text-ink-black transition-colors"
                            title="Correct the invoice date or customer"
                            aria-label={`Edit invoice ${inv.invoiceNumber}`}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                      {/* The chain's status where there is more to say than signed
                          or not: a collection, a credit, an exception. */}
                      {inv.chainStatus && inv.chainStatus !== "DELIVERED" && inv.chainStatus !== "NOT_DELIVERED" ? (
                        <StatusBadge tone={CHAIN_TONE[inv.chainStatus] ?? "idle"} dot>
                          {inv.chainLabel}
                        </StatusBadge>
                      ) : inv.isSigned ? (
                        <StatusBadge tone="green" dot>Delivered</StatusBadge>
                      ) : (
                        <StatusBadge tone="idle" dot>Unsigned</StatusBadge>
                      )}
                      {/* Delivery method: no chip is in-house, with one of our drivers. */}
                      {inv.courier && (
                        <Link
                          href={`/courier/${inv.courier.id}`}
                          className="chip tone-ref hover:underline"
                          title="Goes by courier — open the courier trip sheet"
                        >
                          <b>Courier</b>
                          <span className="chip-sep">·</span>
                          <span className="chip-no">{inv.courier.courierSheetNo}</span>
                        </Link>
                      )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-ink-muted hidden md:table-cell font-mono text-xs">
                      {inv.filename}
                    </td>
                    <td className="px-5 py-3.5 text-ink-muted font-mono text-xs hidden sm:table-cell">
                      {formatSize(inv.sizeBytes)}
                    </td>
                    <td className="px-5 py-3.5 text-right text-ink-muted text-xs hidden sm:table-cell">
                      {inv.isSigned && inv.signedAt
                        ? formatDate(inv.signedAt)
                        : formatDate(inv.lastModified)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="inline-flex items-center gap-2">
                        {inv.recordId && (
                          <Link href={`/invoices/${inv.recordId}`} className="act" title="Delivery, collections and credit notes for this invoice">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" />
                              <path d="M6 8.5v7M8.5 18h7" />
                            </svg>
                            Chain
                          </Link>
                        )}
                        <Link
                          href={`/api/invoices/${encodeURIComponent(inv.filename)}`}
                          target="_blank"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono bg-ink-surface text-ink-muted rounded hover:bg-ink-border hover:text-ink-black transition-all"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                          Original
                        </Link>
                        {inv.isSigned && (
                          <Link
                            href={`/api/invoices/${encodeURIComponent(inv.filename)}?signed=true`}
                            target="_blank"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono bg-ink-green-dim text-ink-green rounded hover:bg-ink-green hover:text-white transition-all"
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                            </svg>
                            Signed
                          </Link>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Selection action bar */}
          {selectedInvoices.size > 0 && (
            <div className="flex items-center justify-between flex-wrap gap-2 px-3 sm:px-5 py-2.5 border-t border-ink-border bg-ink-surface/50 animate-fade-in">
              <p className="text-xs font-mono text-ink-muted">
                {selectedInvoices.size} invoice{selectedInvoices.size !== 1 ? "s" : ""} selected
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setSelectedInvoices(new Set())}
                  className="px-3 py-1.5 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={openDeleteConfirm}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-medium text-white bg-ink-red rounded hover:bg-red-600 transition-all"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  Delete Selected
                </button>
              </div>
            </div>
          )}

          {/* Pagination */}
          {/* Pagination. On a phone the numbered buttons do not fit beside the
              count — the row was wider than the card and clipped off — so a
              compact Prev · n / N · Next takes their place there. */}
          {totalPages > 1 && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 sm:px-5 py-3 border-t border-ink-border bg-ink-surface/50">
              <p className="text-xs font-mono text-ink-muted">
                Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1}–{Math.min(currentPage * ITEMS_PER_PAGE, filteredInvoices.length)} of {filteredInvoices.length}
              </p>
              <div className="flex sm:hidden items-center justify-between gap-2">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="act flex-1 justify-center !h-9"
                >
                  ‹ Prev
                </button>
                <span className="text-xs font-mono text-ink-muted px-2 whitespace-nowrap">
                  {currentPage} / {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="act flex-1 justify-center !h-9"
                >
                  Next ›
                </button>
              </div>
              <div className="hidden sm:flex items-center gap-1">
                <button
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  «
                </button>
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  ‹ Prev
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2)
                  .map((p, idx, arr) => (
                    <span key={p} className="flex items-center">
                      {idx > 0 && arr[idx - 1] !== p - 1 && (
                        <span className="px-1 text-xs text-ink-muted-light">…</span>
                      )}
                      <button
                        onClick={() => setCurrentPage(p)}
                        className={`w-7 h-7 text-xs font-mono rounded transition-colors ${
                          p === currentPage
                            ? "bg-ink-black text-white"
                            : "text-ink-muted hover:text-ink-black hover:bg-ink-surface"
                        }`}
                      >
                        {p}
                      </button>
                    </span>
                  ))}
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Next ›
                </button>
                <button
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                  className="px-2 py-1 text-xs font-mono text-ink-muted hover:text-ink-black disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  »
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={closeDeleteConfirm}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-ink-red-dim flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-red">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-mono text-sm font-medium text-ink-black">Delete {selectedInvoices.size} invoice{selectedInvoices.size !== 1 ? "s" : ""}?</h3>
                  <p className="text-xs text-ink-muted mt-0.5">This action cannot be undone</p>
                </div>
              </div>

              {/* Delete mode selection */}
              <div className="mb-4 space-y-2">
                <p className="text-xs font-mono text-ink-muted uppercase tracking-wide">What to delete</p>
                <label className={`flex items-center gap-3 px-4 py-3 rounded border cursor-pointer transition-all ${deleteMode === "original_only" ? "border-ink-black bg-ink-surface" : "border-ink-border hover:border-ink-black/30"}`}>
                  <input
                    type="radio"
                    name="deleteMode"
                    checked={deleteMode === "original_only"}
                    onChange={() => setDeleteMode("original_only")}
                    className="w-3.5 h-3.5 accent-ink-black cursor-pointer"
                  />
                  <div>
                    <p className="text-sm font-mono font-medium text-ink-black">Original only</p>
                    <p className="text-xs text-ink-muted mt-0.5">Keep signed copies, remove originals</p>
                  </div>
                </label>
                <label className={`flex items-center gap-3 px-4 py-3 rounded border cursor-pointer transition-all ${deleteMode === "both" ? "border-ink-red bg-ink-red-dim/30" : "border-ink-border hover:border-ink-red/30"}`}>
                  <input
                    type="radio"
                    name="deleteMode"
                    checked={deleteMode === "both"}
                    onChange={() => setDeleteMode("both")}
                    className="w-3.5 h-3.5 accent-[#E53935] cursor-pointer"
                  />
                  <div>
                    <p className="text-sm font-mono font-medium text-ink-black">Original + Signed</p>
                    <p className="text-xs text-ink-muted mt-0.5">Remove both original and signed copies permanently</p>
                  </div>
                </label>
              </div>

              {/* Trip sheet impact. Checked before anything is deleted, because
                  a deleted invoice takes its stop off a driver's run. */}
              {tripUsage === null ? (
                <div className="flex items-center gap-2 mb-4 px-3 py-2.5 rounded bg-ink-surface">
                  <div className="w-3.5 h-3.5 border-2 border-ink-border border-t-ink-muted rounded-full animate-spin" />
                  <p className="text-xs font-mono text-ink-muted">Checking active trip sheets…</p>
                </div>
              ) : (
                <>
                  {tripUsageFailed && (
                    <p className="mb-4 px-3 py-2.5 rounded bg-ink-amber-dim text-xs text-ink-amber">
                      Could not check active trip sheets. Any unsigned stop using these invoices will still be taken off its run.
                    </p>
                  )}
                  {usageUnsigned.length > 0 && (
                    <div className="mb-4 rounded border border-ink-red/30 bg-ink-red-dim/30 p-3">
                      <p className="text-xs font-medium text-ink-red mb-1.5">
                        {usageUnsigned.length} invoice{usageUnsigned.length !== 1 ? "s are" : " is"} on an active trip sheet.
                        Deleting will take {usageUnsigned.length !== 1 ? "these stops" : "this stop"} off the driver&apos;s run:
                      </p>
                      <div className="max-h-28 overflow-y-auto space-y-0.5 mb-2">
                        {usageUnsigned.map((u) => (
                          <p key={u.stopId} className="text-xs font-mono text-ink-black truncate">
                            {u.invoiceNumber} — {u.driverName}, stop {u.stopNumber} · {u.customerName}
                            {u.status === "IN_PROGRESS" && <span className="text-ink-amber"> (driver is there now)</span>}
                          </p>
                        ))}
                      </div>
                      <input
                        value={deleteReason}
                        onChange={(e) => setDeleteReason(e.target.value)}
                        maxLength={500}
                        placeholder="Reason, e.g. Invoice cancelled"
                        className="w-full px-2.5 py-1.5 text-xs border border-ink-border rounded bg-white focus:outline-none focus:border-ink-black"
                      />
                      <p className="mt-1.5 text-[11px] text-ink-muted">
                        Only skipping the stop, or one line of it? Cancel, and use Remove… on the stop in Trip Sheets — the PDF is kept.
                      </p>
                    </div>
                  )}
                  {usageSigned.length > 0 && deleteMode === "both" && (
                    <p className="mb-4 px-3 py-2.5 rounded bg-ink-amber-dim text-xs text-ink-amber">
                      {usageSigned.length} of these {usageSigned.length !== 1 ? "were" : "was"} signed on a trip that is still open
                      ({usageSigned.map((u) => u.invoiceNumber).join(", ")}). Deleting the signed copy destroys the proof of
                      delivery — choose &quot;Original only&quot; to keep it.
                    </p>
                  )}
                </>
              )}

              <p className="text-sm text-ink-muted mb-1">
                The following files will be <span className="font-medium text-ink-red">permanently removed</span>:
              </p>
              <div className="max-h-32 overflow-y-auto bg-ink-surface rounded p-2 mb-4">
                {Array.from(selectedInvoices).map((fn) => (
                  <p key={fn} className="text-xs font-mono text-ink-black py-0.5 truncate">{fn}</p>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 bg-ink-surface/50 border-t border-ink-border">
              <button
                onClick={closeDeleteConfirm}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBatchDeleteInvoices}
                disabled={deletingInvoices || tripUsage === null}
                className="flex items-center gap-2 px-4 py-2 text-sm font-mono font-medium text-white bg-ink-red rounded hover:bg-red-600 transition-all disabled:opacity-50"
              >
                {deletingInvoices ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Deleting…
                  </>
                ) : usageUnsigned.length > 0 ? (
                  `Delete & Remove ${usageUnsigned.length} Stop${usageUnsigned.length !== 1 ? "s" : ""}`
                ) : (
                  deleteMode === "original_only" ? "Delete Originals" : "Delete All Copies"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5 space-y-4">
              <div>
                <h3 className="font-mono text-sm font-medium text-ink-black">Invoice {editing.inv.invoiceNumber}</h3>
                <p className="text-xs text-ink-muted mt-1">
                  Correct what was read off the PDF. A date entered here is never overwritten by a later read.
                </p>
              </div>
              <label className="block">
                <span className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">Invoice date</span>
                <input
                  type="date"
                  value={editing.date}
                  onChange={(e) => setEditing({ ...editing, date: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
                />
              </label>
              <label className="block">
                <span className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">Customer</span>
                <input
                  type="text"
                  value={editing.customer}
                  onChange={(e) => setEditing({ ...editing, customer: e.target.value })}
                  maxLength={200}
                  className="w-full px-3 py-2 text-sm bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
                />
                {editing.inv.pdfCustomerName && (
                  <span className="block text-xs text-ink-muted mt-1.5">PDF: {editing.inv.pdfCustomerName}</span>
                )}
              </label>
              {editing.error && <p className="text-xs text-ink-red">{editing.error}</p>}
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-ink-border bg-ink-surface/50">
              <button
                onClick={() => setEditing(null)}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveEdit}
                disabled={editing.saving}
                className="px-5 py-2 text-sm font-mono font-medium rounded bg-ink-green text-white hover:bg-ink-green-hover disabled:opacity-60"
              >
                {editing.saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
