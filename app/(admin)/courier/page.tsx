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
import type { ConfirmationState } from "@/lib/courier-sheet";
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

const DEFAULT_VIEW: ListView = { status: "ALL", q: "", from: "", to: "", page: 1, size: PAGE_SIZE };

function viewFromUrl(): ListView {
  const p = new URLSearchParams(window.location.search);
  const status = p.get("status") as CourierStatus | null;
  const day = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(p.get(k) ?? "") ? p.get(k)! : "");
  const page = Number.parseInt(p.get("page") ?? "", 10);
  const size = Number.parseInt(p.get("size") ?? "", 10);
  return {
    status: status && COURIER_STATUS_ORDER.includes(status) ? status : "ALL",
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
      const filterChanged = (["status", "q", "from", "to", "size"] as const).some(
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
    for (const k of ["status", "q", "from", "to", "page", "size"]) url.searchParams.delete(k);
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

  const v = view ?? DEFAULT_VIEW;
  const status = v.status;
  const reload = () => {
    if (view) void load(view);
  };

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

      <div className="bg-ink-card border border-ink-border rounded">
        <div className="px-4 py-3 border-b border-ink-border space-y-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Status">
            {(["ALL", ...COURIER_STATUS_ORDER] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={status === s}
                onClick={() => change({ status: s })}
                className={`act ${status === s ? "act-primary" : ""}`}
              >
                {s === "ALL" ? "All" : COURIER_STATUS[s].label}
                <span className="opacity-70">{counts[s] ?? 0}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Search sheet, customer, waybill or invoice…"
              aria-label="Search courier trip sheets"
              className="flex-1 min-w-[14rem] px-3 py-1.5 text-sm bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
            />
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              From
              <input type="date" value={v.from} onChange={(e) => change({ from: e.target.value })} className="px-2 py-1 text-sm bg-ink-surface border border-ink-border rounded" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              To
              <input type="date" value={v.to} onChange={(e) => change({ to: e.target.value })} className="px-2 py-1 text-sm bg-ink-surface border border-ink-border rounded" />
            </label>
          </div>
        </div>

        {error && <p className="px-4 py-3 text-sm text-ink-red">{error}</p>}
        {loading ? (
          <p className="px-4 py-6 text-sm text-ink-muted">Loading…</p>
        ) : sheets.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">
            {(counts.ALL ?? 0) === 0 && !v.q && !v.from && !v.to
              ? "No courier trip sheets yet. Upload one to start."
              : "Nothing matches these filters."}
          </p>
        ) : (
          <>
            {/* Table on wider screens */}
            <table className="w-full text-sm hidden md:table">
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
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Cards on a phone */}
            <ul className="md:hidden divide-y divide-ink-border">
              {sheets.map((s) => (
                <li key={s.id}>
                  <Link href={`/courier/${s.id}`} className="block px-4 py-2.5 hover:bg-ink-surface/50">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-ink-black">{s.courierSheetNo}</span>
                      <span className="text-xs text-ink-muted flex-1 min-w-0 truncate whitespace-nowrap">{formatSheetDate(s.sheetDate)}</span>
                      <CourierStatusBadge status={s.status} />
                    </div>
                    <p className="text-sm text-ink-black mt-0.5 truncate">{s.customerName}</p>
                    <p className="text-xs text-ink-muted mt-0.5 font-mono truncate">
                      {s.invoiceCount} invoice{s.invoiceCount === 1 ? "" : "s"} · waybill {s.waybills.join(", ")}
                      {s.parcels ? ` · ${s.parcels} parcel${s.parcels === 1 ? "" : "s"}` : ""}
                    </p>
                    <SheetNotes s={s} />
                  </Link>
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
    </div>
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
