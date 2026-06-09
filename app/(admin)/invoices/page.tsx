"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface InvoiceFile {
  name: string;
  filename: string;
  sizeBytes: number;
  lastModified: string;
  invoiceNumber: string;
  isSigned: boolean;
  signedAt?: string;
}

interface DuplicateGroup {
  invoiceNumber: string;
  filenames: string[];
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
  const [currentPage, setCurrentPage] = useState(1);
  const ITEMS_PER_PAGE = 20;

  // Selection state
  const [selectedInvoices, setSelectedInvoices] = useState<Set<string>>(new Set());
  const [deletingInvoices, setDeletingInvoices] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

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

  // Apply filter to invoices
  const filteredInvoices = data?.invoices.filter((inv) => {
    if (filter === "SIGNED") return inv.isSigned;
    if (filter === "UNSIGNED") return !inv.isSigned;
    return true;
  }) ?? [];

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
    setSelectedInvoices(dupeFiles);
  };

  const handleBatchDeleteInvoices = async () => {
    if (selectedInvoices.size === 0) return;
    setDeletingInvoices(true);
    setError(null);
    try {
      const res = await fetch("/api/invoices", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filenames: Array.from(selectedInvoices) }),
      });
      const result = await res.json();
      if (!res.ok) {
        setError(result.error || "Failed to delete invoices");
      } else {
        setSelectedInvoices(new Set());
        fetchInvoices();
      }
    } catch {
      setError("Failed to delete invoices");
    } finally {
      setDeletingInvoices(false);
      setShowDeleteConfirm(false);
    }
  };

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

      {/* Error state */}
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
          <div className="text-4xl mb-4">{filter === "SIGNED" ? "✍️" : "📋"}</div>
          <p className="font-mono text-sm font-medium text-ink-black mb-2">
            No {filter.toLowerCase()} invoices
          </p>
          <p className="text-xs text-ink-muted max-w-sm mx-auto">
            {filter === "SIGNED"
              ? "No invoices have been signed yet. Drivers will sign invoices during deliveries."
              : "All invoices have been signed."}
          </p>
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
                  <th className="text-left px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide">
                    Status
                  </th>
                  <th className="text-left px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide hidden md:table-cell">
                    Filename
                  </th>
                  <th className="text-left px-5 py-3 font-mono text-xs text-ink-muted uppercase tracking-wide">
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
                        {inv.invoiceNumber}
                        {duplicateFilenames.has(inv.filename) && (
                          <span className="inline-flex items-center px-1.5 py-0.5 text-[9px] font-mono font-medium rounded bg-ink-amber-dim text-ink-amber border border-ink-amber/20">
                            DUPLICATE
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      {inv.isSigned ? (
                        <span className="badge-signed">
                          <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
                          Signed
                        </span>
                      ) : (
                        <span className="badge-pending">
                          <span className="w-1.5 h-1.5 rounded-full bg-ink-red" />
                          Unsigned
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-ink-muted hidden md:table-cell font-mono text-xs">
                      {inv.filename}
                    </td>
                    <td className="px-5 py-3.5 text-ink-muted font-mono text-xs">
                      {formatSize(inv.sizeBytes)}
                    </td>
                    <td className="px-5 py-3.5 text-right text-ink-muted text-xs hidden sm:table-cell">
                      {inv.isSigned && inv.signedAt
                        ? formatDate(inv.signedAt)
                        : formatDate(inv.lastModified)}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="inline-flex items-center gap-2">
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
            <div className="flex items-center justify-between px-5 py-2.5 border-t border-ink-border bg-ink-surface/50 animate-fade-in">
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
                  onClick={() => setShowDeleteConfirm(true)}
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
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-5 py-3 border-t border-ink-border bg-ink-surface/50">
              <p className="text-xs font-mono text-ink-muted">
                Showing {(currentPage - 1) * ITEMS_PER_PAGE + 1}–{Math.min(currentPage * ITEMS_PER_PAGE, filteredInvoices.length)} of {filteredInvoices.length}
              </p>
              <div className="flex items-center gap-1">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
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
              <p className="text-sm text-ink-muted mb-1">
                The following files will be <span className="font-medium text-ink-red">permanently removed</span> from the filesystem, including any signed copies:
              </p>
              <div className="max-h-32 overflow-y-auto bg-ink-surface rounded p-2 mb-4">
                {Array.from(selectedInvoices).map((fn) => (
                  <p key={fn} className="text-xs font-mono text-ink-black py-0.5 truncate">{fn}</p>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 bg-ink-surface/50 border-t border-ink-border">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBatchDeleteInvoices}
                disabled={deletingInvoices}
                className="flex items-center gap-2 px-4 py-2 text-sm font-mono font-medium text-white bg-ink-red rounded hover:bg-red-600 transition-all disabled:opacity-50"
              >
                {deletingInvoices ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Deleting…
                  </>
                ) : (
                  "Delete Permanently"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
