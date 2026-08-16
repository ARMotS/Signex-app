"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useLiveSync } from "@/hooks/useLiveSync";

interface TripStop {
  id: string;
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  nop: number;
  status: "PENDING" | "IN_PROGRESS" | "SIGNED";
  signedAt?: string;
  emailStatus?: string;
  contact?: { email?: string | null };
}

interface TripSheet {
  id: string;
  driverId: string;
  driverName: string;
  regNo: string;
  status: "ACTIVE" | "QUEUED";
  uploadedAt: string;
  sourceFilename: string;
  stops: TripStop[];
}

interface DriverProgress {
  driverId: string;
  driverName: string;
  regNos: string[];
  sheets: number;
  total: number;
  signed: number;
  inProgress: number;
  pending: number;
  lastSignedAt: string | null;
}

interface EmailQueueItem {
  stopId: string;
  invoiceNumber: string;
  customerName: string;
  driverName: string;
  signedAt: string | null;
  emailStatus: string;
  emailError: string | null;
  emailAttempts: number;
  recipient: string | null;
  sendable: boolean;
}

interface RecentSignature {
  stopId: string;
  invoiceNumber: string;
  customerName: string;
  driverName: string;
  signedAt: string | null;
  emailStatus: string;
}

interface CompletedSheet {
  id: string;
  driverName: string;
  regNo: string;
  sourceFilename: string;
  completedAt: string;
  completedBy: string | null;
  totalStops: number;
  signedStops: number;
}

interface DashboardData {
  stats: {
    totalStops: number;
    signed: number;
    pending: number;
    inProgress: number;
    remaining: number;
    completionPct: number;
    stopsDeliveredToday: number;
    signedToday: number;
    activeSheets: number;
    completedSheetsToday: number;
    driversOnRoad: number;
    driversWithSheets: number;
    activeDrivers: number;
    firstSignedToday: string | null;
    lastSignedToday: string | null;
  };
  emails: {
    sent: number;
    failed: number;
    noEmail: number;
    notSent: number;
    sending: number;
    needsAttention: number;
    queue: EmailQueueItem[];
  };
  drivers: DriverProgress[];
  tripSheets: TripSheet[];
  completedToday: CompletedSheet[];
  recentSignatures: RecentSignature[];
}

type Tab = "overview" | "sheets" | "emails";

const timeFmt: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };

function formatTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-ZA", timeFmt);
}

function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-ZA", {
    day: "2-digit",
    month: "short",
    ...timeFmt,
  });
}

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");
  const [expandedSheet, setExpandedSheet] = useState<string | null>(null);
  const [sending, setSending] = useState<Record<string, "sending" | "sent" | "failed">>({});
  const [sendingAll, setSendingAll] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDashboard = useCallback(async () => {
    try {
      // The day boundary follows the machine this is running on, not the
      // server's UTC midnight — see lib/day-window.ts.
      const tzOffset = new Date().getTimezoneOffset();
      const res = await fetch(`/api/dashboard?tzOffset=${tzOffset}`);
      const json = await res.json();
      if (!json.error) setData(json);
    } catch {
      // Leave the last good numbers on screen rather than blanking the
      // dashboard because one poll failed.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Every setState in loadDashboard runs after `await`, so none of them
    // happens synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDashboard();
  }, [loadDashboard]);

  /**
   * Follow the drivers in real time. The dashboard is a wallboard — it is left
   * open all day, so it has to reflect signatures as they happen rather than as
   * of whenever the page was last opened.
   */
  useLiveSync(loadDashboard);

  const stats = data?.stats;
  const emails = data?.emails;
  const queue = useMemo(() => emails?.queue ?? [], [emails]);
  const sendableQueue = useMemo(() => queue.filter((q) => q.sendable), [queue]);

  /** Dispatcher send. The automatic one already tried; this is the follow-up. */
  const sendOne = useCallback(
    async (item: EmailQueueItem) => {
      if (!item.sendable) return false;
      setSending((prev) => ({ ...prev, [item.stopId]: "sending" }));
      try {
        const res = await fetch(`/api/invoices/${item.stopId}/notify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ driverName: item.driverName }),
        });
        const json = await res.json();
        if (json.success) {
          setSending((prev) => ({ ...prev, [item.stopId]: "sent" }));
          return true;
        }
        setSending((prev) => ({ ...prev, [item.stopId]: "failed" }));
        setError(json.error || json.reason || "The email could not be sent");
        return false;
      } catch {
        setSending((prev) => ({ ...prev, [item.stopId]: "failed" }));
        setError("Could not reach the server");
        return false;
      }
    },
    []
  );

  const handleSendOne = async (item: EmailQueueItem) => {
    setError(null);
    const ok = await sendOne(item);
    if (ok) {
      setNotice(`Confirmation sent to ${item.recipient}`);
      setTimeout(() => setNotice(null), 4000);
      loadDashboard();
    }
  };

  /**
   * Clear the whole queue. Sequential on purpose: these go through one SMTP
   * relay, and firing fifty at once is how a shared relay starts rate-limiting
   * a depot's mail.
   */
  const handleSendAll = async () => {
    if (sendableQueue.length === 0) return;
    setSendingAll(true);
    setError(null);
    let ok = 0;
    for (const item of sendableQueue) {
      if (await sendOne(item)) ok++;
    }
    setSendingAll(false);
    setNotice(`${ok} of ${sendableQueue.length} confirmation${sendableQueue.length !== 1 ? "s" : ""} sent`);
    setTimeout(() => setNotice(null), 5000);
    loadDashboard();
  };

  // ─── Stat cards ─────────────────────────────────────────────────────────
  const cards = stats
    ? [
        {
          label: "Delivered Today",
          value: String(stats.stopsDeliveredToday),
          hint:
            stats.firstSignedToday
              ? `First ${formatTime(stats.firstSignedToday)} · last ${formatTime(stats.lastSignedToday)}`
              : "No signatures yet today",
          tone: "text-ink-green",
        },
        {
          label: "Remaining",
          value: String(stats.remaining),
          hint: `${stats.inProgress} in progress · ${stats.pending} not started`,
          tone: stats.remaining > 0 ? "text-ink-amber" : "text-ink-green",
        },
        {
          label: "Drivers On Road",
          value: String(stats.driversOnRoad),
          hint: `${stats.driversWithSheets} with sheets · ${stats.activeDrivers} on the books`,
          tone: "text-ink-black",
        },
        {
          label: "Emails To Send",
          value: String(emails?.needsAttention ?? 0),
          hint:
            (emails?.needsAttention ?? 0) > 0
              ? `${emails?.failed ?? 0} failed · ${emails?.noEmail ?? 0} no address`
              : "All confirmations sent",
          tone: (emails?.needsAttention ?? 0) > 0 ? "text-ink-red" : "text-ink-green",
        },
      ]
    : [];

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "sheets", label: "Active Trip Sheets", badge: stats?.activeSheets },
    { id: "emails", label: "Emails", badge: emails?.needsAttention },
  ];

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-mono text-2xl font-medium text-ink-black tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          {new Date().toLocaleDateString("en-ZA", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
        </div>
      )}

      {!loading && stats && (
        <>
          {/* ─── Stat Cards ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6 stagger-children">
            {cards.map((card) => (
              <div
                key={card.label}
                className="bg-ink-card border border-ink-border rounded p-5 hover:border-ink-muted-light transition-colors"
              >
                <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-3">
                  {card.label}
                </p>
                <p className={`text-3xl font-mono font-medium ${card.tone}`}>{card.value}</p>
                <p className="text-xs text-ink-muted mt-1">{card.hint}</p>
              </div>
            ))}
          </div>

          {/* ─── Day progress bar ────────────────────────────────────────── */}
          <div className="bg-ink-card border border-ink-border rounded p-5 mb-6">
            <div className="flex items-end justify-between mb-3 gap-4 flex-wrap">
              <div>
                <p className="text-xs font-mono text-ink-muted uppercase tracking-wide">
                  Deliveries on active sheets
                </p>
                <p className="text-sm text-ink-black mt-1 font-mono">
                  {stats.signed} of {stats.totalStops} signed
                  <span className="text-ink-muted"> · {stats.completionPct}%</span>
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs font-mono text-ink-muted">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-ink-green" />
                  {stats.signed} signed
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-ink-amber" />
                  {stats.inProgress} in progress
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-ink-red" />
                  {stats.pending} pending
                </span>
              </div>
            </div>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-ink-surface">
              <div
                className="h-full bg-ink-green transition-all duration-500"
                style={{ width: `${pctOf(stats.signed, stats.totalStops)}%` }}
              />
              <div
                className="h-full bg-ink-amber transition-all duration-500"
                style={{ width: `${pctOf(stats.inProgress, stats.totalStops)}%` }}
              />
              <div
                className="h-full bg-ink-red/60 transition-all duration-500"
                style={{ width: `${pctOf(stats.pending, stats.totalStops)}%` }}
              />
            </div>
            <div className="flex items-center gap-5 mt-4 pt-4 border-t border-ink-border text-xs font-mono text-ink-muted flex-wrap">
              <span>
                <span className="text-ink-black">{stats.activeSheets}</span> active sheet
                {stats.activeSheets !== 1 ? "s" : ""}
              </span>
              <span>
                <span className="text-ink-black">{stats.completedSheetsToday}</span> closed out today
              </span>
              <span>
                <span className="text-ink-black">{emails?.sent ?? 0}</span> confirmations sent
              </span>
              {(emails?.sending ?? 0) > 0 && (
                <span className="text-ink-amber">{emails?.sending} sending…</span>
              )}
            </div>
          </div>

          {/* ─── Tabs ────────────────────────────────────────────────────── */}
          <div className="flex items-center gap-1 mb-4 border-b border-ink-border overflow-x-auto">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-2.5 font-mono text-xs uppercase tracking-wide whitespace-nowrap border-b-2 -mb-px transition-colors ${
                  tab === t.id
                    ? "border-ink-green text-ink-black"
                    : "border-transparent text-ink-muted hover:text-ink-black"
                }`}
              >
                {t.label}
                {t.badge !== undefined && t.badge > 0 && (
                  <span
                    className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded-full ${
                      t.id === "emails"
                        ? "bg-ink-red-dim text-ink-red"
                        : "bg-ink-surface text-ink-muted"
                    }`}
                  >
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {error && (
            <div className="mb-4 flex items-center gap-2 px-4 py-3 bg-ink-red-dim rounded border border-ink-red/20 animate-fade-in">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-red shrink-0">
                <circle cx="12" cy="12" r="10" />
                <line x1="15" y1="9" x2="9" y2="15" />
                <line x1="9" y1="9" x2="15" y2="15" />
              </svg>
              <span className="text-sm font-mono text-ink-red flex-1">{error}</span>
              <button
                onClick={() => setError(null)}
                className="text-xs font-mono text-ink-red/70 hover:text-ink-red"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* ─── Overview ────────────────────────────────────────────────── */}
          {tab === "overview" && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 animate-fade-in">
              {/* Driver progress */}
              <div className="bg-ink-card border border-ink-border rounded">
                <div className="px-5 py-4 border-b border-ink-border flex items-center justify-between">
                  <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
                    Driver Progress
                  </h2>
                  <span className="text-xs font-mono text-ink-muted">
                    {data.drivers.length} on the road
                  </span>
                </div>
                {data.drivers.length === 0 ? (
                  <EmptyRow
                    title="No drivers out"
                    hint="Deploy a trip sheet to put drivers on the road"
                  />
                ) : (
                  <div className="divide-y divide-ink-border max-h-[420px] overflow-y-auto">
                    {data.drivers.map((d) => {
                      const pct = pctOf(d.signed, d.total);
                      const done = d.total > 0 && d.signed === d.total;
                      return (
                        <div key={d.driverId} className="flex items-center gap-3 px-5 py-3.5">
                          <div
                            className={`w-8 h-8 rounded flex items-center justify-center shrink-0 ${
                              done ? "bg-ink-green-dim" : "bg-ink-surface"
                            }`}
                          >
                            <span
                              className={`text-xs font-mono font-medium ${
                                done ? "text-ink-green" : "text-ink-muted"
                              }`}
                            >
                              {initials(d.driverName)}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-ink-black truncate">
                                {d.driverName}
                              </p>
                              {d.regNos.length > 0 && (
                                <span className="text-[11px] font-mono text-ink-muted truncate">
                                  {d.regNos.join(", ")}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1">
                              <div className="flex-1 h-1.5 bg-ink-surface rounded-full overflow-hidden max-w-[180px]">
                                <div
                                  className="h-full bg-ink-green rounded-full transition-all duration-500"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-[11px] font-mono text-ink-muted">
                                {d.signed}/{d.total}
                              </span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            {done ? (
                              <span className="badge-signed">
                                <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
                                Done
                              </span>
                            ) : (
                              <span className="text-[11px] font-mono text-ink-muted">
                                {d.lastSignedAt ? `Last ${formatTime(d.lastSignedAt)}` : "Not started"}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Recent signatures */}
              <div className="bg-ink-card border border-ink-border rounded">
                <div className="px-5 py-4 border-b border-ink-border">
                  <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
                    Recent Signatures
                  </h2>
                </div>
                {data.recentSignatures.length === 0 ? (
                  <EmptyRow
                    title="No signatures yet"
                    hint="Deliveries appear here the moment a customer signs"
                  />
                ) : (
                  <div className="divide-y divide-ink-border max-h-[420px] overflow-y-auto">
                    {data.recentSignatures.map((s) => (
                      <div key={s.stopId} className="flex items-center gap-3 px-5 py-3">
                        <div className="w-8 h-8 rounded bg-ink-green-dim flex items-center justify-center shrink-0">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00C07F" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-ink-black truncate">
                            {s.customerName}
                          </p>
                          <p className="text-xs text-ink-muted truncate">
                            {s.invoiceNumber} · {s.driverName}
                          </p>
                        </div>
                        <EmailPill status={s.emailStatus} />
                        <span className="text-xs text-ink-muted font-mono hidden sm:block">
                          {formatTime(s.signedAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Emails needing attention — surfaced on the overview so the
                  dispatcher does not have to go looking for it. */}
              {queue.length > 0 && (
                <div className="bg-ink-card border border-ink-red/30 rounded xl:col-span-2">
                  <div className="flex items-center justify-between px-5 py-4 border-b border-ink-border">
                    <div className="flex items-center gap-2">
                      <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
                        Confirmations Needing You
                      </h2>
                      <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono rounded-full bg-ink-red-dim text-ink-red">
                        {queue.length}
                      </span>
                    </div>
                    <button
                      onClick={() => setTab("emails")}
                      className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
                    >
                      Open queue →
                    </button>
                  </div>
                  <div className="divide-y divide-ink-border">
                    {queue.slice(0, 3).map((item) => (
                      <EmailQueueRow
                        key={item.stopId}
                        item={item}
                        state={sending[item.stopId]}
                        onSend={() => handleSendOne(item)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Closed out today */}
              {data.completedToday.length > 0 && (
                <div className="bg-ink-card border border-ink-border rounded xl:col-span-2">
                  <div className="px-5 py-4 border-b border-ink-border flex items-center justify-between">
                    <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
                      Closed Out Today
                    </h2>
                    <span className="text-xs font-mono text-ink-muted">
                      {data.completedToday.reduce((s, c) => s + c.signedStops, 0)} deliveries
                    </span>
                  </div>
                  <div className="divide-y divide-ink-border">
                    {data.completedToday.slice(0, 6).map((c) => (
                      <div key={c.id} className="flex items-center gap-3 px-5 py-3">
                        <div className="w-8 h-8 rounded bg-ink-surface flex items-center justify-center shrink-0">
                          <span className="text-xs font-mono font-medium text-ink-muted">
                            {initials(c.driverName)}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-ink-black truncate">
                            {c.driverName}
                            {c.regNo && (
                              <span className="text-ink-muted font-mono text-xs ml-2">{c.regNo}</span>
                            )}
                          </p>
                          <p className="text-xs text-ink-muted truncate">{c.sourceFilename}</p>
                        </div>
                        <span className="text-xs font-mono text-ink-muted">
                          {c.signedStops} stops
                        </span>
                        <span className="text-xs font-mono text-ink-muted hidden sm:block">
                          {formatTime(c.completedAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ─── Active Trip Sheets tab ──────────────────────────────────── */}
          {tab === "sheets" && (
            <div className="animate-fade-in">
              {data.tripSheets.length === 0 ? (
                <div className="bg-ink-card border border-ink-border rounded">
                  <EmptyRow
                    title="No active trip sheets"
                    hint="Upload one on the Trip Sheet page to deploy stops to drivers"
                  />
                </div>
              ) : (
                <div className="space-y-3 stagger-children">
                  {data.tripSheets.map((sheet) => {
                    const signed = sheet.stops.filter((s) => s.status === "SIGNED").length;
                    const total = sheet.stops.length;
                    const pct = pctOf(signed, total);
                    const isExpanded = expandedSheet === sheet.id;

                    return (
                      <div
                        key={sheet.id}
                        className="bg-ink-card border border-ink-border rounded overflow-hidden"
                      >
                        <button
                          onClick={() => setExpandedSheet(isExpanded ? null : sheet.id)}
                          className="flex items-center gap-3 w-full px-5 py-4 text-left hover:bg-ink-surface/50 transition-colors"
                        >
                          <div className="w-9 h-9 rounded bg-ink-green-dim flex items-center justify-center shrink-0">
                            <span className="text-xs font-mono font-medium text-ink-green">
                              {initials(sheet.driverName)}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-ink-black">
                                {sheet.driverName}
                              </p>
                              {sheet.regNo && (
                                <span className="text-xs font-mono text-ink-muted">
                                  {sheet.regNo}
                                </span>
                              )}
                              {sheet.status === "QUEUED" && (
                                <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-ink-surface text-ink-muted border border-ink-border">
                                  QUEUED
                                </span>
                              )}
                              {pct === 100 && (
                                <span className="badge-signed">
                                  <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
                                  Ready to close
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-1">
                              <div className="flex-1 h-1.5 bg-ink-surface rounded-full overflow-hidden max-w-[200px]">
                                <div
                                  className="h-full bg-ink-green rounded-full transition-all duration-500"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <span className="text-xs font-mono text-ink-muted">
                                {signed}/{total} signed
                              </span>
                            </div>
                          </div>
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className={`text-ink-muted transition-transform shrink-0 ${
                              isExpanded ? "rotate-180" : ""
                            }`}
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

                        {isExpanded && (
                          <div className="border-t border-ink-border divide-y divide-ink-border animate-fade-in">
                            {sheet.stops.map((stop) => (
                              <div
                                key={stop.id}
                                className="flex items-center gap-3 px-5 py-2.5 text-xs hover:bg-ink-surface/30 transition-colors"
                              >
                                <span className="w-6 h-6 rounded bg-ink-surface flex items-center justify-center font-mono text-ink-muted font-medium shrink-0">
                                  {stop.stopNumber}
                                </span>
                                <span className="font-mono font-medium text-ink-black min-w-[92px]">
                                  {stop.invoiceNumber}
                                </span>
                                <span className="text-ink-muted truncate flex-1">
                                  {stop.customerName}
                                </span>
                                {stop.status === "SIGNED" && (
                                  <EmailPill status={stop.emailStatus} />
                                )}
                                <span className="font-mono text-ink-muted hidden sm:block">
                                  {stop.signedAt ? formatTime(stop.signedAt) : "—"}
                                </span>
                                <StatusBadge status={stop.status} />
                              </div>
                            ))}
                            <div className="px-5 py-2 text-[11px] text-ink-muted bg-ink-surface/30">
                              {sheet.sourceFilename} · uploaded {formatDateTime(sheet.uploadedAt)}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ─── Email queue tab ─────────────────────────────────────────── */}
          {tab === "emails" && (
            <div className="animate-fade-in space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <MiniStat label="Sent" value={emails?.sent ?? 0} tone="text-ink-green" />
                <MiniStat label="Failed" value={emails?.failed ?? 0} tone="text-ink-red" />
                <MiniStat label="No Address" value={emails?.noEmail ?? 0} tone="text-ink-amber" />
                <MiniStat label="Not Sent" value={emails?.notSent ?? 0} tone="text-ink-muted" />
              </div>

              <div className="bg-ink-card border border-ink-border rounded">
                <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-ink-border">
                  <div>
                    <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
                      Send Queue
                    </h2>
                    <p className="text-xs text-ink-muted mt-0.5">
                      Confirmations that did not go out automatically when the customer signed
                    </p>
                  </div>
                  {sendableQueue.length > 0 && (
                    <button
                      onClick={handleSendAll}
                      disabled={sendingAll}
                      className="flex items-center gap-2 px-4 py-2 bg-ink-green text-white font-mono text-xs font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all disabled:opacity-50 shrink-0"
                    >
                      {sendingAll ? (
                        <>
                          <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                          Sending…
                        </>
                      ) : (
                        <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="22" y1="2" x2="11" y2="13" />
                            <polygon points="22 2 15 22 11 13 2 9 22 2" />
                          </svg>
                          Send all {sendableQueue.length}
                        </>
                      )}
                    </button>
                  )}
                </div>

                {queue.length === 0 ? (
                  <EmptyRow
                    title="Nothing waiting"
                    hint="Every signed delivery has had its confirmation sent"
                  />
                ) : (
                  <div className="divide-y divide-ink-border">
                    {queue.map((item) => (
                      <EmailQueueRow
                        key={item.stopId}
                        item={item}
                        state={sending[item.stopId]}
                        onSend={() => handleSendOne(item)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      {/* Success toast */}
      {notice && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 px-5 py-3 bg-ink-green text-white rounded-lg shadow-lg animate-fade-in">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span className="text-sm font-mono font-medium">{notice}</span>
        </div>
      )}
    </div>
  );
}

// ─── Small pieces ─────────────────────────────────────────────────────────

function pctOf(part: number, whole: number) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function EmptyRow({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm font-mono text-ink-muted">{title}</p>
      <p className="text-xs text-ink-muted mt-1">{hint}</p>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="bg-ink-card border border-ink-border rounded p-4">
      <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-mono font-medium ${tone}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const signed = status === "SIGNED";
  const active = status === "IN_PROGRESS";
  return (
    <span className={signed ? "badge-signed" : active ? "badge-progress" : "badge-pending"}>
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          signed ? "bg-ink-green" : active ? "bg-ink-amber" : "bg-ink-red"
        }`}
      />
      {signed ? "Signed" : active ? "Active" : "Pending"}
    </span>
  );
}

/** Where the customer's confirmation email got to, at a glance. */
function EmailPill({ status }: { status?: string }) {
  if (status === "SENT") {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono rounded bg-ink-green-dim text-ink-green shrink-0"
        title="Confirmation email sent"
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Emailed
      </span>
    );
  }

  const map: Record<string, { label: string; className: string; title: string }> = {
    SENDING: {
      label: "Sending",
      className: "bg-ink-surface text-ink-muted",
      title: "Confirmation email is being sent",
    },
    FAILED: {
      label: "Failed",
      className: "bg-ink-red-dim text-ink-red",
      title: "Confirmation email failed — send it from the queue",
    },
    NO_EMAIL: {
      label: "No address",
      className: "bg-ink-amber-dim text-ink-amber",
      title: "This customer has no email address on file",
    },
    NOT_SENT: {
      label: "Not sent",
      className: "bg-ink-surface text-ink-muted",
      title: "No confirmation has gone out yet",
    },
  };

  // An unrecognised or absent status is "we have no evidence it went" — never
  // silently rendered as sent.
  const pill = (status && map[status]) || map.NOT_SENT;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded shrink-0 ${pill.className}`}
      title={pill.title}
    >
      {pill.label}
    </span>
  );
}

function EmailQueueRow({
  item,
  state,
  onSend,
}: {
  item: EmailQueueItem;
  state?: "sending" | "sent" | "failed";
  onSend: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-ink-surface/40 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-ink-black truncate">{item.customerName}</p>
          <span className="font-mono text-xs text-ink-muted">{item.invoiceNumber}</span>
          <EmailPill status={item.emailStatus} />
        </div>
        <p className="text-xs text-ink-muted mt-0.5 truncate">
          {item.recipient ?? "No email address on file"}
          {" · "}
          {item.driverName}
          {item.signedAt ? ` · signed ${formatTime(item.signedAt)}` : ""}
          {item.emailAttempts > 0 ? ` · ${item.emailAttempts} attempt${item.emailAttempts !== 1 ? "s" : ""}` : ""}
        </p>
        {item.emailError && (
          <p className="text-[11px] font-mono text-ink-red mt-1 truncate" title={item.emailError}>
            {item.emailError}
          </p>
        )}
      </div>

      {item.sendable ? (
        <button
          onClick={onSend}
          disabled={state === "sending" || state === "sent"}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono font-medium transition-all shrink-0 ${
            state === "sent"
              ? "bg-ink-green-dim text-ink-green border border-ink-green/20 cursor-default"
              : state === "failed"
              ? "bg-ink-red-dim text-ink-red border border-ink-red/20 hover:bg-ink-red/10"
              : state === "sending"
              ? "bg-ink-surface text-ink-muted border border-ink-border cursor-wait"
              : "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
          }`}
        >
          {state === "sending" && (
            <>
              <div className="w-3 h-3 border-2 border-ink-muted/30 border-t-ink-muted rounded-full animate-spin" />
              Sending…
            </>
          )}
          {state === "sent" && (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Sent
            </>
          )}
          {state === "failed" && "Retry"}
          {!state && "Send"}
        </button>
      ) : (
        <a
          href="/contacts"
          className="px-3 py-1.5 rounded text-xs font-mono font-medium border border-ink-amber/30 text-ink-amber hover:bg-ink-amber-dim transition-all shrink-0"
          title="Add an email address to this contact first"
        >
          Add address
        </a>
      )}
    </div>
  );
}
