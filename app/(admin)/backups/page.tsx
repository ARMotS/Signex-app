"use client";

import { useState, useEffect, useCallback } from "react";
import { FilterSearch } from "@/components/admin/FilterSearch";
import { matchesTokens, tokenizeQuery } from "@/lib/search-match";
import { DocChip, StatusBadge } from "@/components/ui/Chips";

/**
 * Backups: download what Signex has filed, and clear out what may be cleared.
 *
 * Four kinds of file. Signed invoices and completed trip sheets can be
 * purged once downloaded. Signed collection receipts and signed credit notes
 * are DOWNLOAD-ONLY: their Signed/ folders are the record a credit is
 * reconciled against, and nothing is ever deleted from them. A backup with
 * credit notes in it also carries credit-register.csv, tracing each note to
 * its invoice and collections.
 */

type SectionKey = "invoices" | "trips" | "receipts" | "credits";

interface FileRow {
  filename: string;
  sizeBytes: number;
  /** When it was signed, processed or filed. */
  date: string;
  /** Extra text a search should find (credit number, invoice, customer). */
  searchExtra?: string[];
  creditNo?: string | null;
  invoiceNo?: string | null;
  customerName?: string | null;
}

interface Summary {
  invoices: { filename: string; sizeBytes: number; signedAt: string }[];
  tripSheets: { filename: string; sizeBytes: number; processedAt: string }[];
  collections: { filename: string; sizeBytes: number; signedAt: string }[];
  creditNotes: {
    filename: string;
    sizeBytes: number;
    signedAt: string;
    creditNo: string | null;
    invoiceNo: string | null;
    customerName: string | null;
  }[];
}

const SECTIONS: {
  key: SectionKey;
  title: string;
  dateLabel: string;
  purgeable: boolean;
  note?: string;
}[] = [
  { key: "invoices", title: "Signed Invoices", dateLabel: "Signed", purgeable: true },
  { key: "trips", title: "Completed Trip Sheets", dateLabel: "Processed", purgeable: true },
  {
    key: "receipts",
    title: "Signed Collection Receipts",
    dateLabel: "Signed",
    purgeable: false,
    note: "Kept permanently in Collections/Signed — download only.",
  },
  {
    key: "credits",
    title: "Signed Credit Notes",
    dateLabel: "Filed",
    purgeable: false,
    note: "Kept permanently in the credits folder's Signed/ — download only. The download includes credit-register.csv.",
  },
];

type DatePreset = "ALL" | "7D" | "30D" | "90D" | "CUSTOM";
type KindFilter = "ALL" | SectionKey;
type SortOrder = "NEWEST" | "OLDEST" | "NAME" | "LARGEST";

/**
 * Detailed search over the listing already in memory — text, kind, a date
 * range and sort. It narrows what is shown; "Older than" above it still decides
 * what the server returns.
 */
interface BackupSearch {
  query: string;
  kind: KindFilter;
  /** yyyy-mm-dd, inclusive, in the admin's local day. Empty = open-ended. */
  from: string;
  to: string;
  sort: SortOrder;
}

const EMPTY_SEARCH: BackupSearch = { query: "", kind: "ALL", from: "", to: "", sort: "NEWEST" };

const emptySets = (): Record<SectionKey, Set<string>> => ({
  invoices: new Set(),
  trips: new Set(),
  receipts: new Set(),
  credits: new Set(),
});
const allPages = (): Record<SectionKey, number> => ({ invoices: 1, trips: 1, receipts: 1, credits: 1 });

function applySearch(rows: FileRow[], search: BackupSearch, formatDate: (iso: string) => string): FileRow[] {
  const tokens = tokenizeQuery(search.query);
  const fromMs = search.from ? new Date(`${search.from}T00:00:00`).getTime() : null;
  const toMs = search.to ? new Date(`${search.to}T23:59:59.999`).getTime() : null;
  const out = rows.filter((row) => {
    const t = new Date(row.date).getTime();
    if (fromMs !== null && t < fromMs) return false;
    if (toMs !== null && t > toMs) return false;
    // The formatted date is searchable too, so "oct 2026" finds a month.
    return matchesTokens(tokens, [row.filename, formatDate(row.date), ...(row.searchExtra ?? [])]);
  });
  const byDate = (a: FileRow, b: FileRow) => new Date(a.date).getTime() - new Date(b.date).getTime();
  switch (search.sort) {
    case "NEWEST": return out.sort((a, b) => byDate(b, a));
    case "OLDEST": return out.sort(byDate);
    case "NAME": return out.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    case "LARGEST": return out.sort((a, b) => b.sizeBytes - a.sizeBytes);
  }
}

/** Rows per page in each backup table — the same as the trip sheet folder listing. */
const BACKUPS_PER_PAGE = 10;

/** The page actually shown: a purge can shrink a list out from under its page. */
function clampPage(page: number, total: number): number {
  return Math.min(page, Math.max(1, Math.ceil(total / BACKUPS_PER_PAGE)));
}

/** Footer pager, matching the trip sheet page's cloud folder pagination. */
function Pager({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  if (total <= BACKUPS_PER_PAGE) return null;
  const totalPages = Math.ceil(total / BACKUPS_PER_PAGE);
  return (
    <div className="flex items-center justify-between px-5 py-2.5 border-t border-ink-border bg-ink-surface/30">
      <p className="text-xs font-mono text-ink-muted">
        {(page - 1) * BACKUPS_PER_PAGE + 1}–{Math.min(page * BACKUPS_PER_PAGE, total)} of {total}
      </p>
      <div className="flex items-center gap-1">
        <button onClick={() => onPage(Math.max(1, page - 1))} disabled={page === 1} className="act">
          ‹ Prev
        </button>
        <span className="text-xs font-mono text-ink-muted px-1">
          {page}/{totalPages}
        </span>
        <button onClick={() => onPage(Math.min(totalPages, page + 1))} disabled={page === totalPages} className="act">
          Next ›
        </button>
      </div>
    </div>
  );
}

const Chevron = ({ open }: { open: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`} aria-hidden="true">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const DownloadIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
  </svg>
);

const formatSize = (b: number) => {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
};

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function BackupsPage() {
  const [rows, setRows] = useState<Record<SectionKey, FileRow[]>>({ invoices: [], trips: [], receipts: [], credits: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [datePreset, setDatePreset] = useState<DatePreset>("ALL");
  const [customDate, setCustomDate] = useState("");

  const [selected, setSelected] = useState<Record<SectionKey, Set<string>>>(emptySets);
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({ invoices: true, trips: true, receipts: true, credits: true });
  const [pages, setPages] = useState<Record<SectionKey, number>>(allPages);

  const [downloading, setDownloading] = useState(false);
  const [purging, setPurging] = useState(false);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  const [search, setSearch] = useState<BackupSearch>(EMPTY_SEARCH);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Every search change starts every table back on page 1. */
  const updateSearch = (patch: Partial<BackupSearch>) => {
    setSearch((s) => ({ ...s, ...patch }));
    setPages(allPages());
  };

  const getBeforeDate = useCallback((): string | null => {
    const now = new Date();
    switch (datePreset) {
      case "7D": return new Date(now.getTime() - 7 * 86400000).toISOString();
      case "30D": return new Date(now.getTime() - 30 * 86400000).toISOString();
      case "90D": return new Date(now.getTime() - 90 * 86400000).toISOString();
      case "CUSTOM": return customDate ? new Date(customDate).toISOString() : null;
      default: return null;
    }
  }, [datePreset, customDate]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const before = getBeforeDate();
      const url = before ? `/api/backups?before=${encodeURIComponent(before)}` : "/api/backups";
      const res = await fetch(url);
      const json = (await res.json()) as Summary & { error?: string };
      if (json.error) { setError(json.error); return; }
      setRows({
        invoices: (json.invoices ?? []).map((i) => ({ filename: i.filename, sizeBytes: i.sizeBytes, date: i.signedAt })),
        trips: (json.tripSheets ?? []).map((t) => ({ filename: t.filename, sizeBytes: t.sizeBytes, date: t.processedAt })),
        receipts: (json.collections ?? []).map((c) => ({ filename: c.filename, sizeBytes: c.sizeBytes, date: c.signedAt })),
        credits: (json.creditNotes ?? []).map((n) => ({
          filename: n.filename,
          sizeBytes: n.sizeBytes,
          date: n.signedAt,
          creditNo: n.creditNo,
          invoiceNo: n.invoiceNo,
          customerName: n.customerName,
          searchExtra: [n.creditNo ?? "", n.invoiceNo ?? "", n.customerName ?? ""],
        })),
      });
    } catch {
      setError("Failed to load backup data");
    } finally {
      setLoading(false);
    }
  }, [getBeforeDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    setSelected(emptySets());
    setPages(allPages());
  }, [datePreset, customDate]);

  const filtered: Record<SectionKey, FileRow[]> = {
    invoices: [], trips: [], receipts: [], credits: [],
  };
  for (const s of SECTIONS) {
    filtered[s.key] = search.kind === "ALL" || search.kind === s.key ? applySearch(rows[s.key], search, formatDate) : [];
  }
  const totalAll = SECTIONS.reduce((n, s) => n + rows[s.key].length, 0);
  const totalMatches = SECTIONS.reduce((n, s) => n + filtered[s.key].length, 0);
  const totalSelected = SECTIONS.reduce((n, s) => n + selected[s.key].size, 0);
  const purgeableSelected = selected.invoices.size + selected.trips.size;
  const searchActive = search.query.trim() !== "" || search.kind !== "ALL" || search.from !== "" || search.to !== "";
  const advancedActive = search.kind !== "ALL" || search.from !== "" || search.to !== "" || search.sort !== "NEWEST";

  const toggle = (key: SectionKey, filename: string) => {
    setSelected((prev) => {
      const n = new Set(prev[key]);
      if (n.has(filename)) n.delete(filename);
      else n.add(filename);
      return { ...prev, [key]: n };
    });
  };
  // The header checkbox covers the rows on screen only, so a purge never takes
  // rows the admin has not seen. "Select all" in the page header covers the rest.
  const togglePage = (key: SectionKey, pageRows: FileRow[], allOn: boolean) => {
    setSelected((prev) => {
      const n = new Set(prev[key]);
      for (const r of pageRows) {
        if (allOn) n.delete(r.filename);
        else n.add(r.filename);
      }
      return { ...prev, [key]: n };
    });
  };
  // With a search applied this selects the matches only — what the admin sees
  // listed is what goes into the download or the purge.
  const selectAll = () => {
    setSelected({
      invoices: new Set(filtered.invoices.map((r) => r.filename)),
      trips: new Set(filtered.trips.map((r) => r.filename)),
      receipts: new Set(filtered.receipts.map((r) => r.filename)),
      credits: new Set(filtered.credits.map((r) => r.filename)),
    });
  };

  const handleDownload = async () => {
    if (totalSelected === 0) return;
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceFilenames: Array.from(selected.invoices),
          tripSheetFilenames: Array.from(selected.trips),
          collectionFilenames: Array.from(selected.receipts),
          creditNoteFilenames: Array.from(selected.credits),
        }),
      });
      if (!res.ok) { const j = await res.json(); setError(j.error || "Download failed"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `signex-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch { setError("Failed to download backup"); } finally { setDownloading(false); }
  };

  const handlePurge = async () => {
    if (purgeableSelected === 0) return;
    setPurging(true);
    setError(null);
    setPurgeResult(null);
    try {
      const res = await fetch("/api/backups", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceFilenames: Array.from(selected.invoices), tripSheetFilenames: Array.from(selected.trips) }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || "Purge failed"); return; }
      const p = json.purged;
      setPurgeResult(`Purged ${p.invoicesDeleted} invoices and ${p.tripSheetsDeleted} trip sheets`);
      setSelected((prev) => ({ ...prev, invoices: new Set(), trips: new Set() }));
      fetchData();
    } catch { setError("Failed to purge items"); } finally { setPurging(false); setShowPurgeConfirm(false); }
  };

  const presetLabel = (p: DatePreset) => {
    switch (p) {
      case "ALL": return "All";
      case "7D": return "> 7 days";
      case "30D": return "> 30 days";
      case "90D": return "> 90 days";
      case "CUSTOM": return "Custom";
    }
  };

  const summaryLine = [
    `${rows.invoices.length} signed invoices`,
    `${rows.trips.length} completed trip sheets`,
    `${rows.receipts.length} collection receipts`,
    `${rows.credits.length} signed credit notes`,
  ].join(" · ");

  return (
    <div className={`animate-fade-in ${totalSelected > 0 ? "pb-20" : ""}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="font-mono text-2xl font-medium text-ink-black tracking-tight">Backups</h1>
          <p className="text-sm text-ink-muted mt-1">
            {loading ? "Scanning…" : error ? "Error loading data" : `${summaryLine} available`}
          </p>
        </div>
        {totalSelected > 0 && (
          <button onClick={selectAll} className="act">
            {searchActive ? `Select all ${totalMatches} matching` : `Select all (${totalAll})`}
          </button>
        )}
      </div>

      {/* Date filter */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <span className="text-xs font-mono text-ink-muted uppercase tracking-wide">Older than</span>
        <div className="flex gap-1 bg-ink-card border border-ink-border rounded p-0.5">
          {(["ALL", "7D", "30D", "90D", "CUSTOM"] as DatePreset[]).map((p) => (
            <button key={p} onClick={() => setDatePreset(p)}
              className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${datePreset === p ? "bg-ink-black text-white" : "text-ink-muted hover:text-ink-black"}`}>
              {presetLabel(p)}
            </button>
          ))}
        </div>
        {datePreset === "CUSTOM" && (
          <input type="date" value={customDate} onChange={(e) => setCustomDate(e.target.value)}
            className="px-3 py-1.5 text-xs font-mono bg-ink-card border border-ink-border rounded text-ink-black focus:outline-none focus:border-ink-green" />
        )}
      </div>

      {/* Detailed search — narrows the listing above without another fetch */}
      {!loading && !error && totalAll > 0 && (
        <div className="mb-6 bg-ink-card border border-ink-border rounded p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <FilterSearch
              value={search.query}
              onChange={(query) => updateSearch({ query })}
              placeholder="Search filename, invoice or credit no., customer or date…"
              matchCount={totalMatches}
              totalCount={totalAll}
              noun="file"
              shortcut
              className="flex-1 min-w-[220px]"
            />
            <button
              type="button"
              onClick={() => setSearchOpen((o) => !o)}
              aria-expanded={searchOpen}
              className={`act ${advancedActive ? "act-green" : ""}`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="4" y1="6" x2="20" y2="6" /><line x1="7" y1="12" x2="17" y2="12" /><line x1="10" y1="18" x2="14" y2="18" />
              </svg>
              Filters{advancedActive ? " · on" : ""}
            </button>
            {(searchActive || search.sort !== "NEWEST") && (
              <button type="button" onClick={() => updateSearch(EMPTY_SEARCH)} className="act">
                Reset
              </button>
            )}
          </div>

          {searchOpen && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-3 pt-3 border-t border-ink-border">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-mono text-ink-muted uppercase tracking-wide">Type</span>
                <select
                  value={search.kind}
                  onChange={(e) => updateSearch({ kind: e.target.value as KindFilter })}
                  className="px-2 py-1.5 text-xs font-mono bg-ink-card border border-ink-border rounded text-ink-black focus:outline-none focus:border-ink-green"
                >
                  <option value="ALL">All files</option>
                  <option value="invoices">Signed invoices</option>
                  <option value="trips">Completed trip sheets</option>
                  <option value="receipts">Collection receipts</option>
                  <option value="credits">Signed credit notes</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-mono text-ink-muted uppercase tracking-wide">Signed / processed from</span>
                <input
                  type="date"
                  value={search.from}
                  max={search.to || undefined}
                  onChange={(e) => updateSearch({ from: e.target.value })}
                  className="px-2 py-1.5 text-xs font-mono bg-ink-card border border-ink-border rounded text-ink-black focus:outline-none focus:border-ink-green"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-mono text-ink-muted uppercase tracking-wide">To</span>
                <input
                  type="date"
                  value={search.to}
                  min={search.from || undefined}
                  onChange={(e) => updateSearch({ to: e.target.value })}
                  className="px-2 py-1.5 text-xs font-mono bg-ink-card border border-ink-border rounded text-ink-black focus:outline-none focus:border-ink-green"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-mono text-ink-muted uppercase tracking-wide">Sort by</span>
                <select
                  value={search.sort}
                  onChange={(e) => updateSearch({ sort: e.target.value as SortOrder })}
                  className="px-2 py-1.5 text-xs font-mono bg-ink-card border border-ink-border rounded text-ink-black focus:outline-none focus:border-ink-green"
                >
                  <option value="NEWEST">Newest first</option>
                  <option value="OLDEST">Oldest first</option>
                  <option value="NAME">Filename (A–Z)</option>
                  <option value="LARGEST">Largest first</option>
                </select>
              </label>
            </div>
          )}
        </div>
      )}

      {/* Success message */}
      {purgeResult && (
        <div className="flex items-center gap-2 mb-4 px-4 py-2.5 bg-ink-green-dim border border-ink-green/20 rounded animate-fade-in">
          <p className="text-xs font-mono text-[color:var(--tone-green-fg)] flex-1">{purgeResult}</p>
          <button onClick={() => setPurgeResult(null)} className="act act-icon" aria-label="Dismiss">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-ink-red-dim border border-ink-red/20 rounded p-4 mb-4">
          <p className="text-sm font-mono text-ink-red">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-ink-muted">Scanning for backupable items…</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && totalAll === 0 && (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <p className="font-mono text-sm font-medium text-ink-black mb-2">Nothing to back up</p>
          <p className="text-xs text-ink-muted max-w-sm mx-auto">
            Signed invoices, completed trip sheets, collection receipts and signed credit notes appear here when available.
          </p>
        </div>
      )}

      {!loading && !error && totalAll > 0 && (
        <div className="space-y-4">
          {totalMatches === 0 && (
            <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-10 text-center">
              <p className="font-mono text-sm font-medium text-ink-black mb-2">No files match this search</p>
              <button onClick={() => updateSearch(EMPTY_SEARCH)} className="act">Reset search</button>
            </div>
          )}

          {SECTIONS.map((section) => {
            const list = filtered[section.key];
            if (list.length === 0) return null;
            const all = rows[section.key];
            const sel = selected[section.key];
            const page = clampPage(pages[section.key], list.length);
            const pageRows = list.slice((page - 1) * BACKUPS_PER_PAGE, page * BACKUPS_PER_PAGE);
            const allPageOn = pageRows.length > 0 && pageRows.every((r) => sel.has(r.filename));
            const isOpen = open[section.key];
            return (
              <div key={section.key} className="bg-ink-card border border-ink-border rounded overflow-hidden">
                <button
                  onClick={() => setOpen((o) => ({ ...o, [section.key]: !o[section.key] }))}
                  className="flex items-center gap-3 w-full px-5 py-3.5 text-left hover:bg-ink-surface/50 transition-colors flex-wrap"
                  aria-expanded={isOpen}
                >
                  <Chevron open={isOpen} />
                  <span className="font-mono text-sm font-medium text-ink-black">{section.title}</span>
                  {!section.purgeable && <StatusBadge tone="idle">Download only</StatusBadge>}
                  <span className="ml-auto text-xs font-mono text-ink-muted">
                    {searchActive && list.length !== all.length ? `${list.length} of ${all.length}` : all.length} files ·{" "}
                    {formatSize(list.reduce((s, r) => s + r.sizeBytes, 0))}
                  </span>
                  {sel.size > 0 && <StatusBadge tone="green">{sel.size} selected</StatusBadge>}
                </button>

                {isOpen && (
                  <div className="border-t border-ink-border">
                    {section.note && (
                      <p className="px-5 py-2 text-[11px] text-ink-muted bg-ink-surface/40 border-b border-ink-border">{section.note}</p>
                    )}
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-ink-border">
                            <th className="text-left px-5 py-2.5 w-10">
                              <input type="checkbox" checked={allPageOn} onChange={() => togglePage(section.key, pageRows, allPageOn)}
                                aria-label={`Select this page of ${section.title.toLowerCase()}`}
                                className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F] cursor-pointer" />
                            </th>
                            <th className="text-left px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide">
                              {section.key === "credits" ? "Credit note" : "Filename"}
                            </th>
                            <th className="text-left px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide">Size</th>
                            <th className="text-right px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide hidden sm:table-cell">
                              {section.dateLabel}
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-ink-border">
                          {pageRows.map((r) => (
                            <tr key={r.filename}
                              className={`hover:bg-ink-surface/50 transition-colors cursor-pointer ${sel.has(r.filename) ? "bg-ink-green-dim/20" : ""}`}
                              onClick={() => toggle(section.key, r.filename)}>
                              <td className="px-5 py-3 w-10" onClick={(e) => e.stopPropagation()}>
                                <input type="checkbox" checked={sel.has(r.filename)} onChange={() => toggle(section.key, r.filename)}
                                  aria-label={`Select ${r.filename}`}
                                  className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F] cursor-pointer" />
                              </td>
                              <td className="px-5 py-3 font-mono text-xs text-ink-black">
                                {section.key === "credits" && r.creditNo ? (
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <DocChip kind="CN" number={r.creditNo} tone="blue" />
                                    {r.invoiceNo && <DocChip kind="INV" number={r.invoiceNo} tone="ref" />}
                                    {r.customerName && <span className="text-ink-muted">{r.customerName}</span>}
                                    <span className="basis-full text-[11px] text-ink-muted">{r.filename}</span>
                                  </div>
                                ) : (
                                  r.filename
                                )}
                              </td>
                              <td className="px-5 py-3 font-mono text-xs text-ink-muted">{formatSize(r.sizeBytes)}</td>
                              <td className="px-5 py-3 text-right text-xs text-ink-muted hidden sm:table-cell">{formatDate(r.date)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Pager page={page} total={list.length} onPage={(p) => setPages((prev) => ({ ...prev, [section.key]: p }))} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Sticky action bar ─────────────────────────────────────── */}
      {totalSelected > 0 && (
        <div className="fixed bottom-0 left-0 right-0 md:left-56 z-40 bg-ink-card border-t border-ink-border px-5 py-3 animate-fade-in mb-[env(safe-area-inset-bottom)]">
          <div className="flex items-center justify-between max-w-5xl mx-auto gap-3 flex-wrap">
            <p className="text-xs font-mono text-ink-muted">
              {SECTIONS.filter((s) => selected[s.key].size > 0)
                .map((s) => `${selected[s.key].size} ${s.title.toLowerCase().replace(/^signed |^completed /, "")}`)
                .join(" · ")}{" "}
              selected
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => setSelected(emptySets())} className="act">
                Clear
              </button>
              <button onClick={handleDownload} disabled={downloading} className="act act-primary">
                {downloading ? (
                  <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Creating…</>
                ) : (
                  <><DownloadIcon />Download ZIP</>
                )}
              </button>
              {purgeableSelected > 0 && (
                <button onClick={() => setShowPurgeConfirm(true)} disabled={purging} className="act act-red">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  Purge {purgeableSelected}…
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Purge confirmation ────────────────────────────────────── */}
      {showPurgeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => setShowPurgeConfirm(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <h3 className="font-mono text-sm font-medium text-ink-black">
                Purge {purgeableSelected} file{purgeableSelected !== 1 ? "s" : ""}?
              </h3>
              <p className="text-xs text-ink-muted mt-0.5 mb-4">This cannot be undone — download them first.</p>
              <p className="text-sm text-ink-muted mb-3">
                The following will be <span className="font-medium text-ink-red">permanently removed</span>:
              </p>
              <div className="space-y-2 mb-4">
                {SECTIONS.filter((s) => s.purgeable && selected[s.key].size > 0).map((s) => (
                  <div key={s.key} className="bg-ink-surface rounded p-2">
                    <p className="text-xs font-mono text-ink-muted mb-1">{s.title} ({selected[s.key].size})</p>
                    <div className="max-h-20 overflow-y-auto">
                      {Array.from(selected[s.key]).map((fn) => (
                        <p key={fn} className="text-xs font-mono text-ink-black py-0.5 truncate">{fn}</p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              {(selected.receipts.size > 0 || selected.credits.size > 0) && (
                <p className="text-xs text-ink-muted">
                  Selected collection receipts and credit notes are not purged — they stay in their Signed/ folders.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 bg-ink-surface/50 border-t border-ink-border">
              <button onClick={() => setShowPurgeConfirm(false)} className="act">Cancel</button>
              <button onClick={handlePurge} disabled={purging} className="act act-red">
                {purging ? "Purging…" : "Purge permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
