"use client";

/**
 * Courier: invoices that leave with a courier rather than one of our drivers.
 * One sheet per customer, imported from the Trip application's export; the
 * courier driver signs for it at the office and the customer confirms receipt.
 * See lib/courier-import.ts.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConfirmationState } from "@/lib/courier-sheet";
import CourierUpload from "@/components/admin/courier/CourierUpload";
import CourierInbox, { type InboxState } from "@/components/admin/courier/CourierInbox";
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

export default function CourierPage() {
  const router = useRouter();
  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [status, setStatus] = useState<CourierStatus | "ALL">("ALL");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [inbox, setInbox] = useState<InboxState | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/courier")
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          setSheets(data.sheets);
          setInbox(data.inbox);
          setError(null);
        })
        .catch(() => setError("Could not load courier trip sheets"))
        .finally(() => setLoading(false)),
    []
  );

  // Each load also schedules a look at the courier folder (throttled on the
  // server to once a minute), so a sheet the Trip application saves turns up
  // here without anyone pressing anything — while the tab is open and seen.
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: sheets.length };
    for (const s of sheets) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [sheets]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sheets.filter((s) => {
      if (status !== "ALL" && s.status !== status) return false;
      if (from && s.sheetDate < from) return false;
      if (to && s.sheetDate > to) return false;
      if (!q) return true;
      return [s.courierSheetNo, s.customerName, s.courierCompany ?? "", ...s.waybills, ...s.invoiceNos].some((v) =>
        v.toLowerCase().includes(q)
      );
    });
  }, [sheets, status, query, from, to]);

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

      {inbox && <CourierInbox inbox={inbox} onChanged={() => void load()} />}

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
                onClick={() => setStatus(s)}
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
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search sheet, customer, waybill or invoice…"
              aria-label="Search courier trip sheets"
              className="flex-1 min-w-[14rem] px-3 py-1.5 text-sm bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
            />
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="px-2 py-1 text-sm bg-ink-surface border border-ink-border rounded" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              To
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="px-2 py-1 text-sm bg-ink-surface border border-ink-border rounded" />
            </label>
          </div>
        </div>

        {error && <p className="px-4 py-3 text-sm text-ink-red">{error}</p>}
        {loading ? (
          <p className="px-4 py-6 text-sm text-ink-muted">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-6 text-sm text-ink-muted">
            {sheets.length === 0 ? "No courier trip sheets yet. Upload one to start." : "Nothing matches these filters."}
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
                {shown.map((s) => (
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
              {shown.map((s) => (
                <li key={s.id}>
                  <Link href={`/courier/${s.id}`} className="block px-4 py-3 hover:bg-ink-surface/50">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-ink-black">{s.courierSheetNo}</span>
                      <span className="text-xs text-ink-muted">{formatSheetDate(s.sheetDate)}</span>
                    </div>
                    <p className="text-sm text-ink-black mt-0.5">{s.customerName}</p>
                    <p className="text-xs text-ink-muted mt-0.5 font-mono">
                      {s.invoiceCount} invoice{s.invoiceCount === 1 ? "" : "s"} · waybill {s.waybills.join(", ")}
                      {s.parcels ? ` · ${s.parcels} parcel${s.parcels === 1 ? "" : "s"}` : ""}
                    </p>
                    <div className="mt-2">
                      <SheetState s={s} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
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
