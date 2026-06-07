"use client";

import { useState, useEffect, useCallback } from "react";

interface BackupInvoice {
  filename: string;
  sizeBytes: number;
  signedAt: string;
}

interface BackupTripSheet {
  id: string;
  driverName: string;
  regNo: string;
  date: string;
  sourceFilename: string;
  stopCount: number;
  uploadedBy: string;
}

type DatePreset = "ALL" | "7D" | "30D" | "90D" | "CUSTOM";

export default function BackupsPage() {
  const [invoices, setInvoices] = useState<BackupInvoice[]>([]);
  const [tripSheets, setTripSheets] = useState<BackupTripSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [datePreset, setDatePreset] = useState<DatePreset>("ALL");
  const [customDate, setCustomDate] = useState("");

  const [selectedInvoices, setSelectedInvoices] = useState<Set<string>>(new Set());
  const [selectedTrips, setSelectedTrips] = useState<Set<string>>(new Set());

  const [downloading, setDownloading] = useState(false);
  const [purging, setPurging] = useState(false);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  const [invoicesOpen, setInvoicesOpen] = useState(true);
  const [tripsOpen, setTripsOpen] = useState(true);

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
      const json = await res.json();
      if (json.error) { setError(json.error); return; }
      setInvoices(json.invoices || []);
      setTripSheets(json.tripSheets || []);
    } catch {
      setError("Failed to load backup data");
    } finally {
      setLoading(false);
    }
  }, [getBeforeDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    setSelectedInvoices(new Set());
    setSelectedTrips(new Set());
  }, [datePreset, customDate]);

  const formatSize = (b: number) => {
    if (b < 1024) return `${b} B`;
    if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1048576).toFixed(1)} MB`;
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

  const totalSelected = selectedInvoices.size + selectedTrips.size;

  const toggleInvoice = (f: string) => {
    setSelectedInvoices((prev) => { const n = new Set(prev); n.has(f) ? n.delete(f) : n.add(f); return n; });
  };
  const toggleTrip = (id: string) => {
    setSelectedTrips((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const toggleAllInvoices = () => {
    setSelectedInvoices((prev) => prev.size === invoices.length ? new Set() : new Set(invoices.map((i) => i.filename)));
  };
  const toggleAllTrips = () => {
    setSelectedTrips((prev) => prev.size === tripSheets.length ? new Set() : new Set(tripSheets.map((t) => t.id)));
  };
  const selectAll = () => {
    setSelectedInvoices(new Set(invoices.map((i) => i.filename)));
    setSelectedTrips(new Set(tripSheets.map((t) => t.id)));
  };

  const handleDownload = async (mode: "invoices" | "trips" | "both") => {
    const invFiles = mode === "trips" ? [] : Array.from(selectedInvoices);
    const tripIds = mode === "invoices" ? [] : Array.from(selectedTrips);
    if (invFiles.length === 0 && tripIds.length === 0) return;
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch("/api/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceFilenames: invFiles, tripSheetIds: tripIds }),
      });
      if (!res.ok) { const j = await res.json(); setError(j.error || "Download failed"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const suffix = mode === "invoices" ? "-invoices" : mode === "trips" ? "-tripsheets" : "";
      a.download = `signex-backup${suffix}-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch { setError("Failed to download backup"); } finally { setDownloading(false); }
  };

  const handlePurge = async () => {
    if (totalSelected === 0) return;
    setPurging(true);
    setError(null);
    setPurgeResult(null);
    try {
      const res = await fetch("/api/backups", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invoiceFilenames: Array.from(selectedInvoices), tripSheetIds: Array.from(selectedTrips) }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || "Purge failed"); return; }
      const p = json.purged;
      setPurgeResult(`Purged ${p.invoicesDeleted} invoices and ${p.tripSheetsDeleted} trip sheets`);
      setSelectedInvoices(new Set());
      setSelectedTrips(new Set());
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

  // Chevron SVG helper
  const Chevron = ({ open }: { open: boolean }) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`transition-transform duration-200 ${open ? "rotate-90" : ""}`}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="font-mono text-2xl font-medium text-ink-black tracking-tight">Backups</h1>
          <p className="text-sm text-ink-muted mt-1">
            {loading ? "Scanning…" : error ? "Error loading data" : `${invoices.length} signed invoices · ${tripSheets.length} completed trip sheets available`}
          </p>
        </div>
        {totalSelected > 0 && (
          <button onClick={selectAll}
            className="px-3 py-1.5 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors">
            Select All ({invoices.length + tripSheets.length})
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

      {/* Success message */}
      {purgeResult && (
        <div className="flex items-center gap-2 mb-4 px-4 py-2.5 bg-ink-green-dim border border-ink-green/20 rounded animate-fade-in">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-green shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <p className="text-xs font-mono text-ink-green">{purgeResult}</p>
          <button onClick={() => setPurgeResult(null)} className="ml-auto text-ink-green/60 hover:text-ink-green">✕</button>
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
      {!loading && !error && invoices.length === 0 && tripSheets.length === 0 && (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <div className="text-4xl mb-4">📦</div>
          <p className="font-mono text-sm font-medium text-ink-black mb-2">Nothing to back up</p>
          <p className="text-xs text-ink-muted max-w-sm mx-auto">
            Signed invoices and completed trip sheets will appear here when available.
          </p>
        </div>
      )}

      {!loading && !error && (invoices.length > 0 || tripSheets.length > 0) && (
        <div className="space-y-4">
          {/* ── Signed Invoices Section ─────────────────────────────── */}
          {invoices.length > 0 && (
            <div className="bg-ink-card border border-ink-border rounded overflow-hidden">
              <button onClick={() => setInvoicesOpen(!invoicesOpen)}
                className="flex items-center gap-3 w-full px-5 py-3.5 text-left hover:bg-ink-surface/50 transition-colors">
                <Chevron open={invoicesOpen} />
                <span className="font-mono text-sm font-medium text-ink-black">Signed Invoices</span>
                <span className="ml-auto text-xs font-mono text-ink-muted">{invoices.length} files · {formatSize(invoices.reduce((s, i) => s + i.sizeBytes, 0))}</span>
                {selectedInvoices.size > 0 && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ink-green-dim text-ink-green">{selectedInvoices.size} selected</span>
                )}
              </button>

              {invoicesOpen && (
                <div className="border-t border-ink-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ink-border">
                        <th className="text-left px-5 py-2.5 w-10">
                          <input type="checkbox" checked={invoices.length > 0 && selectedInvoices.size === invoices.length} onChange={toggleAllInvoices}
                            className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F] cursor-pointer" />
                        </th>
                        <th className="text-left px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide">Filename</th>
                        <th className="text-left px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide">Size</th>
                        <th className="text-right px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide hidden sm:table-cell">Signed</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-border">
                      {invoices.map((inv) => (
                        <tr key={inv.filename}
                          className={`hover:bg-ink-surface/50 transition-colors cursor-pointer ${selectedInvoices.has(inv.filename) ? "bg-ink-green-dim/20" : ""}`}
                          onClick={() => toggleInvoice(inv.filename)}>
                          <td className="px-5 py-3 w-10" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={selectedInvoices.has(inv.filename)} onChange={() => toggleInvoice(inv.filename)}
                              className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F] cursor-pointer" />
                          </td>
                          <td className="px-5 py-3 font-mono text-xs text-ink-black">{inv.filename}</td>
                          <td className="px-5 py-3 font-mono text-xs text-ink-muted">{formatSize(inv.sizeBytes)}</td>
                          <td className="px-5 py-3 text-right text-xs text-ink-muted hidden sm:table-cell">{formatDate(inv.signedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── Completed Trip Sheets Section ──────────────────────── */}
          {tripSheets.length > 0 && (
            <div className="bg-ink-card border border-ink-border rounded overflow-hidden">
              <button onClick={() => setTripsOpen(!tripsOpen)}
                className="flex items-center gap-3 w-full px-5 py-3.5 text-left hover:bg-ink-surface/50 transition-colors">
                <Chevron open={tripsOpen} />
                <span className="font-mono text-sm font-medium text-ink-black">Completed Trip Sheets</span>
                <span className="ml-auto text-xs font-mono text-ink-muted">{tripSheets.length} sheets · {tripSheets.reduce((s, t) => s + t.stopCount, 0)} stops</span>
                {selectedTrips.size > 0 && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ink-green-dim text-ink-green">{selectedTrips.size} selected</span>
                )}
              </button>

              {tripsOpen && (
                <div className="border-t border-ink-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-ink-border">
                        <th className="text-left px-5 py-2.5 w-10">
                          <input type="checkbox" checked={tripSheets.length > 0 && selectedTrips.size === tripSheets.length} onChange={toggleAllTrips}
                            className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F] cursor-pointer" />
                        </th>
                        <th className="text-left px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide">Driver</th>
                        <th className="text-left px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide hidden md:table-cell">Reg No</th>
                        <th className="text-left px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide">Stops</th>
                        <th className="text-left px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide hidden sm:table-cell">Source</th>
                        <th className="text-right px-5 py-2.5 font-mono text-xs text-ink-muted uppercase tracking-wide">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-ink-border">
                      {tripSheets.map((ts) => (
                        <tr key={ts.id}
                          className={`hover:bg-ink-surface/50 transition-colors cursor-pointer ${selectedTrips.has(ts.id) ? "bg-ink-green-dim/20" : ""}`}
                          onClick={() => toggleTrip(ts.id)}>
                          <td className="px-5 py-3 w-10" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={selectedTrips.has(ts.id)} onChange={() => toggleTrip(ts.id)}
                              className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F] cursor-pointer" />
                          </td>
                          <td className="px-5 py-3 font-mono text-xs font-medium text-ink-black">{ts.driverName}</td>
                          <td className="px-5 py-3 font-mono text-xs text-ink-muted hidden md:table-cell">{ts.regNo}</td>
                          <td className="px-5 py-3">
                            <span className="badge-signed">{ts.stopCount} stops</span>
                          </td>
                          <td className="px-5 py-3 font-mono text-xs text-ink-muted hidden sm:table-cell truncate max-w-[160px]">{ts.sourceFilename}</td>
                          <td className="px-5 py-3 text-right text-xs text-ink-muted">{formatDate(ts.date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

       {/* ── Sticky Action Bar ─────────────────────────────────────── */}
      {totalSelected > 0 && (
        <div className="fixed bottom-0 left-0 right-0 md:left-56 z-40 bg-ink-card border-t border-ink-border px-5 py-3 animate-fade-in mb-[env(safe-area-inset-bottom)]"
          style={{ bottom: "0px" }}>
          <div className="flex items-center justify-between max-w-5xl mx-auto gap-3 flex-wrap">
            <p className="text-xs font-mono text-ink-muted">
              {selectedInvoices.size > 0 && <span>{selectedInvoices.size} invoice{selectedInvoices.size !== 1 ? "s" : ""}</span>}
              {selectedInvoices.size > 0 && selectedTrips.size > 0 && <span> · </span>}
              {selectedTrips.size > 0 && <span>{selectedTrips.size} trip sheet{selectedTrips.size !== 1 ? "s" : ""}</span>}
              <span> selected</span>
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <button onClick={() => { setSelectedInvoices(new Set()); setSelectedTrips(new Set()); }}
                className="px-3 py-1.5 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors">
                Clear
              </button>
              {selectedInvoices.size > 0 && selectedTrips.size > 0 && (
                <>
                  <button onClick={() => handleDownload("invoices")} disabled={downloading}
                    className="flex items-center gap-2 px-3 py-2 text-xs font-mono font-medium text-ink-green bg-ink-green-dim border border-ink-green/20 rounded hover:bg-ink-green/10 transition-all disabled:opacity-50">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Invoices Only
                  </button>
                  <button onClick={() => handleDownload("trips")} disabled={downloading}
                    className="flex items-center gap-2 px-3 py-2 text-xs font-mono font-medium text-ink-green bg-ink-green-dim border border-ink-green/20 rounded hover:bg-ink-green/10 transition-all disabled:opacity-50">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Trip Sheets Only
                  </button>
                </>
              )}
              <button onClick={() => handleDownload("both")} disabled={downloading}
                className="flex items-center gap-2 px-4 py-2 text-xs font-mono font-medium text-white bg-ink-green rounded hover:bg-ink-green-hover transition-all disabled:opacity-50">
                {downloading ? (
                  <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Creating…</>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    {selectedInvoices.size > 0 && selectedTrips.size > 0 ? "Download All" : selectedInvoices.size > 0 ? "Download Invoices" : "Download Trip Sheets"}
                  </>
                )}
              </button>
              <button onClick={() => setShowPurgeConfirm(true)} disabled={purging}
                className="flex items-center gap-2 px-4 py-2 text-xs font-mono font-medium text-white bg-ink-red rounded hover:bg-red-600 transition-all disabled:opacity-50">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Purge Selected
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Purge Confirmation Modal ──────────────────────────────── */}
      {showPurgeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => setShowPurgeConfirm(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-ink-red-dim flex items-center justify-center">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-red">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-mono text-sm font-medium text-ink-black">Purge {totalSelected} item{totalSelected !== 1 ? "s" : ""}?</h3>
                  <p className="text-xs text-ink-muted mt-0.5">This action cannot be undone</p>
                </div>
              </div>
              <p className="text-sm text-ink-muted mb-3">
                The following will be <span className="font-medium text-ink-red">permanently removed</span>:
              </p>
              <div className="space-y-2 mb-4">
                {selectedInvoices.size > 0 && (
                  <div className="bg-ink-surface rounded p-2">
                    <p className="text-xs font-mono text-ink-muted mb-1">Signed Invoices ({selectedInvoices.size})</p>
                    <div className="max-h-20 overflow-y-auto">
                      {Array.from(selectedInvoices).map((fn) => (
                        <p key={fn} className="text-xs font-mono text-ink-black py-0.5 truncate">{fn}</p>
                      ))}
                    </div>
                  </div>
                )}
                {selectedTrips.size > 0 && (
                  <div className="bg-ink-surface rounded p-2">
                    <p className="text-xs font-mono text-ink-muted mb-1">Trip Sheets ({selectedTrips.size})</p>
                    <div className="max-h-20 overflow-y-auto">
                      {tripSheets.filter((t) => selectedTrips.has(t.id)).map((t) => (
                        <p key={t.id} className="text-xs font-mono text-ink-black py-0.5 truncate">{t.driverName} — {t.sourceFilename}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 bg-ink-surface/50 border-t border-ink-border">
              <button onClick={() => setShowPurgeConfirm(false)}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors">Cancel</button>
              <button onClick={handlePurge} disabled={purging}
                className="flex items-center gap-2 px-4 py-2 text-sm font-mono font-medium text-white bg-ink-red rounded hover:bg-red-600 transition-all disabled:opacity-50">
                {purging ? (
                  <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />Purging…</>
                ) : "Purge Permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
