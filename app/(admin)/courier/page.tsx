"use client";

/**
 * Courier: invoices that leave with a courier rather than one of our drivers.
 * One sheet per customer, imported from the Trip application's export; the
 * courier driver signs for it at the office and the customer confirms receipt.
 * See lib/courier-import.ts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  COURIER_ACTIVE_STATUSES,
  COURIER_OPEN_STATUSES,
  courierTabOf,
  type ConfirmationState,
  type CourierTab,
} from "@/lib/courier-sheet";
import { useLiveSync } from "@/hooks/useLiveSync";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import StatusTabs from "@/components/ui/StatusTabs";
import CourierUpload from "@/components/admin/courier/CourierUpload";
import CourierInbox, { type InboxState } from "@/components/admin/courier/CourierInbox";
import Pager from "@/components/ui/Pager";
import CourierStatusBadge, {
  COURIER_STATUS,
  COURIER_STATUS_ORDER,
  formatSheetDate,
  type CourierStatus,
} from "@/components/admin/courier/CourierStatusBadge";

interface SheetSummary {
  id: string;
  courierSheetNo: string;
  sheetDate: string;
  customerName: string;
  waybills: string[];
  invoiceCount: number;
  invoiceNos: string[];
  parcels: number | null;
  courierCompany: string | null;
  status: CourierStatus;
  blockCount: number;
  warningCount: number;
  hasEmail: boolean;
  confirmation: ConfirmationState | null;
}

/** After the handover, what the office reads beside the status. */
const CONFIRMATION_NOTE: Record<ConfirmationState, { text: string; tone: "muted" | "amber" | "red" } | null> = {
  filing: { text: "Copies not filed", tone: "red" },
  email_problem: { text: "Email not sent", tone: "amber" },
  sending: { text: "Emailing customer", tone: "muted" },
  awaiting: { text: "Awaiting confirmation", tone: "muted" },
  reminded: { text: "Reminder sent", tone: "muted" },
  no_answer: { text: "No answer — phone them", tone: "red" },
  confirmed: null,
};

/** The list's filters and page, as the URL carries them. */
interface ListView {
  tab: CourierTab;
  status: CourierStatus | "ALL";
  q: string;
  from: string;
  to: string;
  page: number;
  size: number;
}

/** Ten a page: the tab sits under the folder panels, so a long page meant a lot of scrolling. */
const PAGE_SIZE = 10;
const PAGE_SIZES = [10, 25, 50] as const;

const DEFAULT_VIEW: ListView = { tab: "active", status: "ALL", q: "", from: "", to: "", page: 1, size: PAGE_SIZE };

function viewFromUrl(): ListView {
  const p = new URLSearchParams(window.location.search);
  const status = p.get("status") as CourierStatus | null;
  const day = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(p.get(k) ?? "") ? p.get(k)! : "");
  const page = Number.parseInt(p.get("page") ?? "", 10);
  const size = Number.parseInt(p.get("size") ?? "", 10);
  const known = status && COURIER_STATUS_ORDER.includes(status) ? status : null;
  return {
    // A link to one status opens on that status's tab.
    tab: known ? courierTabOf(known) : p.get("tab") === "completed" ? "completed" : "active",
    status: known ?? "ALL",
    q: (p.get("q") ?? "").slice(0, 100),
    from: day("from"),
    to: day("to"),
    page: page > 0 ? page : 1,
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : PAGE_SIZE,
  };
}

/** Only what differs from the defaults, so a plain visit keeps a plain URL. */
function viewToParams(v: ListView): URLSearchParams {
  const p = new URLSearchParams();
  if (v.tab !== "active") p.set("tab", v.tab);
  if (v.status !== "ALL") p.set("status", v.status);
  if (v.q.trim()) p.set("q", v.q.trim());
  if (v.from) p.set("from", v.from);
  if (v.to) p.set("to", v.to);
  if (v.page > 1) p.set("page", String(v.page));
  if (v.size !== PAGE_SIZE) p.set("size", String(v.size));
  return p;
}

export default function CourierPage() {
  const router = useRouter();
  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  // What the list shows. Typing goes to `typed` first and reaches the view
  // after a pause, so each keystroke is not a request.
  const [view, setView] = useState<ListView | null>(null);
  const [typed, setTyped] = useState("");
  const seq = useRef(0);

  const [inbox, setInbox] = useState<InboxState | null>(null);

  // The URL's view, once, after mount (the server render has no URL).
  useEffect(() => {
    const t = setTimeout(() => {
      const v = viewFromUrl();
      setView(v);
      setTyped(v.q);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  /** Change the filters (back to page 1) or the page. */
  const change = useCallback((patch: Partial<ListView>) => {
    setView((v) => {
      const base = v ?? DEFAULT_VIEW;
      const filterChanged = (["tab", "status", "q", "from", "to", "size"] as const).some(
        (k) => k in patch && patch[k] !== base[k]
      );
      return { ...base, ...patch, page: patch.page ?? (filterChanged ? 1 : base.page) };
    });
  }, []);

  useEffect(() => {
    if (!view || typed === view.q) return;
    const t = setTimeout(() => change({ q: typed }), 300);
    return () => clearTimeout(t);
  }, [typed, view, change]);

  const load = useCallback(async (v: ListView) => {
    const id = ++seq.current;
    const params = viewToParams(v);
    params.set("view", "page");
    params.set("tab", v.tab);
    if (!params.has("size")) params.set("size", String(v.size));
    try {
      const res = await fetch(`/api/courier?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (id !== seq.current) return; // a newer request is on its way
      setSheets(data.sheets);
      setTotal(data.total);
      setCounts(data.counts ?? {});
      setInbox(data.inbox);
      setError(null);
      // The server answers the last page when asked past the end.
      if (typeof data.page === "number" && data.page !== v.page) change({ page: data.page });
    } catch {
      if (id === seq.current) setError("Could not load courier trip sheets");
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [change]);

  // Load whenever the view changes, and keep the URL in step with it.
  useEffect(() => {
    if (!view) return;
    const url = new URL(window.location.href);
    for (const k of ["tab", "status", "q", "from", "to", "page", "size"]) url.searchParams.delete(k);
    viewToParams(view).forEach((value, k) => url.searchParams.set(k, value));
    window.history.replaceState(window.history.state, "", url.toString());
    void load(view);
  }, [view, load]);

  // Each load also schedules a look at the courier folder (throttled on the
  // server to once a minute), so a sheet the Trip application saves turns up
  // here without anyone pressing anything — while the tab is open and seen.
  // Only the page in view is re-read.
  useEffect(() => {
    if (!view) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load(view);
    }, 60_000);
    return () => clearInterval(timer);
  }, [view, load]);

  // A sheet changes tab the moment a customer confirms it.
  useLiveSync(() => {
    if (view) void load(view);
  });

  const v = view ?? DEFAULT_VIEW;
  const status = v.status;
  const reload = () => {
    if (view) void load(view);
  };

  const [deleting, setDeleting] = useState<SheetSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const askDelete = (s: SheetSummary) => {
    setDeleteError(null);
    setDeleting(s);
  };
  const removeSheet = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/courier/${deleting.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setDeleteError(data.error || "That sheet could not be deleted");
        reload();
        return;
      }
      setDeleting(null);
      reload();
    } catch {
      setDeleteError("Failed to connect to server");
    } finally {
      setDeleteBusy(false);
    }
  };
  const activeCount = COURIER_ACTIVE_STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0);

  return (
    <div className="animate-fade-in">
      <div className="mb-6 flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[16rem]">
          <h1 className="font-mono text-lg font-medium text-ink-black">Courier</h1>
          <p className="text-sm text-ink-muted mt-1">
            Invoices sent with a courier. The courier driver signs for the sheet here; the customer confirms receipt
            from their email.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowUpload((v) => !v)}
          className={`px-4 py-2.5 font-mono text-sm font-medium rounded transition-all ${
            showUpload ? "bg-ink-black text-white" : "bg-ink-green text-white hover:bg-ink-green-hover"
          }`}
        >
          {showUpload ? "Close" : "Upload courier sheet"}
        </button>
      </div>

      {inbox && <CourierInbox inbox={inbox} onChanged={reload} />}

      {showUpload && (
        <div className="mb-6">
          <CourierUpload
            onImported={(id) => {
              setShowUpload(false);
              router.push(`/courier/${id}`);
            }}
          />
        </div>
      )}

      <div className="bg-ink-card border border-ink-border rounded overflow-hidden">
        <StatusTabs
          active={v.tab}
          onChange={(tab) => change({ tab, status: "ALL" })}
          tabs={[
            { id: "active" as const, label: "Active Sheets", short: "Active", count: activeCount },
            { id: "completed" as const, label: "Completed", short: "Completed", count: counts.DELIVERED ?? 0 },
          ]}
        />
        <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-ink-border bg-ink-surface/30">
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search sheet, customer, waybill or invoice…"
            aria-label="Search courier trip sheets"
            className="w-full xl:w-auto xl:flex-1 min-w-[14rem] px-3 py-1.5 text-sm bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
          />
          {/* Completed holds one status, so there is nothing to narrow it to. */}
          {v.tab === "active" && (
            <select
              value={status}
              onChange={(e) => change({ status: e.target.value as ListView["status"] })}
              aria-label="Filter by status"
              className={`h-8 px-2 text-xs font-mono rounded border bg-ink-card outline-none focus:border-ink-green ${
                status !== "ALL" ? "border-ink-green text-ink-black" : "border-ink-border text-ink-muted"
              }`}
            >
              <option value="ALL">Any status ({activeCount})</option>
              {COURIER_ACTIVE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {COURIER_STATUS[s].label} ({counts[s] ?? 0})
                </option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            From
            <input type="date" value={v.from} onChange={(e) => change({ from: e.target.value })} className="px-2 py-1 text-sm bg-ink-surface border border-ink-border rounded" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            To
            <input type="date" value={v.to} onChange={(e) => change({ to: e.target.value })} className="px-2 py-1 text-sm bg-ink-surface border border-ink-border rounded" />
          </label>
        </div>

        {error && <p className="px-4 py-3 text-sm text-ink-red">{error}</p>}
        {loading ? (
          <p className="px-4 py-6 text-sm text-ink-muted">Loading…</p>
        ) : sheets.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">
            {(counts.ALL ?? 0) === 0 && !v.q && !v.from && !v.to
              ? "No courier trip sheets yet. Upload one to start."
              : !v.q && !v.from && !v.to && status === "ALL"
                ? v.tab === "active"
                  ? "No active courier trip sheets."
                  : "No sheets have been confirmed by the customer yet."
                : "Nothing matches these filters."}
          </p>
        ) : (
          <>
            {/* The table needs about 1210px of window once the sidebar has its
                share. Square monitors and small windows fall short of that, so
                it starts at xl; the scroller keeps one very long value inside
                the card instead of sliding the page under the sidebar. */}
            <div className="hidden xl:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">
                  <tr className="border-b border-ink-border">
                    <th className="px-4 py-2 text-left font-normal">Sheet</th>
                    <th className="px-4 py-2 text-left font-normal">Date</th>
                    <th className="px-4 py-2 text-left font-normal">Customer</th>
                    <th className="px-4 py-2 text-left font-normal">Waybill</th>
                    <th className="px-4 py-2 text-right font-normal">Invoices</th>
                    <th className="px-4 py-2 text-right font-normal">Parcels</th>
                    <th className="px-4 py-2 text-left font-normal">Courier</th>
                    <th className="px-4 py-2 text-left font-normal">Status</th>
                    <th className="px-2 py-2"><span className="sr-only">Delete</span></th>
                  </tr>
                </thead>
                <tbody>
                  {sheets.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => router.push(`/courier/${s.id}`)}
                      className="border-b border-ink-border last:border-0 hover:bg-ink-surface/50 cursor-pointer"
                    >
                      <td className="px-4 py-3 font-mono">
                        <Link href={`/courier/${s.id}`} className="text-ink-black hover:underline" onClick={(e) => e.stopPropagation()}>
                          {s.courierSheetNo}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-ink-muted whitespace-nowrap">{formatSheetDate(s.sheetDate)}</td>
                      <td className="px-4 py-3 text-ink-black">{s.customerName}</td>
                      <td className="px-4 py-3 font-mono text-ink-muted">
                        {s.waybills[0]}
                        {s.waybills.length > 1 ? ` +${s.waybills.length - 1}` : ""}
                      </td>
                      <td className="px-4 py-3 text-right">{s.invoiceCount}</td>
                      <td className="px-4 py-3 text-right">{s.parcels ?? "—"}</td>
                      <td className="px-4 py-3 text-ink-muted">{s.courierCompany ?? "—"}</td>
                      <td className="px-4 py-3">
                        <SheetState s={s} />
                      </td>
                      <td className="px-2 py-3 text-right">
                        {isOpen(s) && <DeleteSheetButton s={s} onClick={() => askDelete(s)} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Cards everywhere the table does not fit */}
            <ul className="xl:hidden divide-y divide-ink-border">
              {sheets.map((s) => (
                <li key={s.id} className="flex items-start">
                  <Link href={`/courier/${s.id}`} className="block flex-1 min-w-0 px-4 py-2.5 hover:bg-ink-surface/50">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-ink-black">{s.courierSheetNo}</span>
                      <span className="text-xs text-ink-muted flex-1 min-w-0 truncate whitespace-nowrap">{formatSheetDate(s.sheetDate)}</span>
                      <CourierStatusBadge status={s.status} />
                    </div>
                    <p className="text-sm text-ink-black mt-0.5 truncate">{s.customerName}</p>
                    <p className="text-xs text-ink-muted mt-0.5 font-mono break-words">
                      {s.invoiceCount} invoice{s.invoiceCount === 1 ? "" : "s"} · waybill {s.waybills.join(", ")}
                      {s.parcels ? ` · ${s.parcels} parcel${s.parcels === 1 ? "" : "s"}` : ""}
                      {s.courierCompany ? ` · ${s.courierCompany}` : ""}
                    </p>
                    <SheetNotes s={s} />
                  </Link>
                  {isOpen(s) && (
                    <div className="shrink-0 pt-2.5 pr-2">
                      <DeleteSheetButton s={s} onClick={() => askDelete(s)} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <Pager
              page={v.page}
              pageSize={v.size}
              total={total}
              onPage={(page) => change({ page })}
              onPageSize={(size) => change({ size })}
              sizes={PAGE_SIZES}
              disabled={loading}
            />
          </>
        )}
      </div>

      {deleting && (
        <ConfirmDialog
          title={`Delete courier trip sheet ${deleting.courierSheetNo}?`}
          confirmLabel="Delete sheet"
          busyLabel="Deleting…"
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={removeSheet}
        >
          <p>
            For a sheet imported by mistake. Its invoices are free to go on another sheet; the original Excel stays in
            its folder.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Not yet signed for: the server refuses anything else, so nothing else offers it. */
function isOpen(s: SheetSummary): boolean {
  return (COURIER_OPEN_STATUSES as readonly string[]).includes(s.status);
}

function DeleteSheetButton({ s, onClick }: { s: SheetSummary; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="act act-icon hover:!text-ink-red"
      aria-label={`Delete courier trip sheet ${s.courierSheetNo}`}
      title="Delete"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18" />
        <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
        <path d="M19 6l-1 14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 6" />
      </svg>
    </button>
  );
}

/** On a phone: the notes under the sheet, only when there are any. */
function SheetNotes({ s }: { s: SheetSummary }) {
  type Note = { text: string; tone: "red" | "amber" | "muted" };
  const conf = s.confirmation ? CONFIRMATION_NOTE[s.confirmation] : null;
  const notes = [
    s.blockCount > 0 && { text: `${s.blockCount} to fix`, tone: "red" },
    conf && { text: conf.text, tone: conf.tone === "red" ? "red" : conf.tone === "amber" ? "amber" : "muted" },
    !s.hasEmail && (s.status === "NEEDS_ATTENTION" || s.status === "AWAITING_COLLECTION") && { text: "No email", tone: "amber" },
  ].filter(Boolean) as Note[];
  if (notes.length === 0) return null;
  return (
    <p className="text-xs mt-0.5">
      {notes.map((n, i) => (
        <span
          key={n.text}
          className={n.tone === "red" ? "text-ink-red" : n.tone === "muted" ? "text-ink-muted" : ""}
          style={n.tone === "amber" ? { color: "var(--tone-amber-fg)" } : undefined}
        >
          {i > 0 && " · "}
          {n.text}
        </span>
      ))}
    </p>
  );
}

function SheetState({ s }: { s: SheetSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <CourierStatusBadge status={s.status} />
      {s.blockCount > 0 && (
        <span className="text-xs text-ink-red">
          {s.blockCount} to fix
        </span>
      )}
      {s.confirmation && CONFIRMATION_NOTE[s.confirmation] && (
        <span
          className={`text-xs ${CONFIRMATION_NOTE[s.confirmation]!.tone === "red" ? "text-ink-red" : CONFIRMATION_NOTE[s.confirmation]!.tone === "muted" ? "text-ink-muted" : ""}`}
          style={CONFIRMATION_NOTE[s.confirmation]!.tone === "amber" ? { color: "var(--tone-amber-fg)" } : undefined}
        >
          {CONFIRMATION_NOTE[s.confirmation]!.text}
        </span>
      )}
      {!s.hasEmail && (s.status === "NEEDS_ATTENTION" || s.status === "AWAITING_COLLECTION") && (
        <span className="text-xs" style={{ color: "var(--tone-amber-fg)" }}>
          No email
        </span>
      )}
    </div>
  );
}
