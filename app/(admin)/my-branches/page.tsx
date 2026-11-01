"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Pager from "@/components/ui/Pager";
import { StatusBadge } from "@/components/ui/Chips";

/**
 * COMPANY_ADMIN: its allocated branches side by side, read-only — today's
 * numbers per branch (Overview) and what happened in them (Activity). Each
 * branch is read on its own on the server; "Open" switches the scope there
 * to act. Works with or without a branch chosen.
 */

interface BranchSummary {
  tenantId: string;
  name: string;
  deliveredToday: number;
  remainingStops: number;
  activeSheets: number;
  driversOnRoad: number;
  closedOutToday: number;
  emailsToFix: number;
  courierAttention: number;
  collectionsPending: number;
  awaitingApproval: number;
  creditNotesToReview: number;
  creditNotesToSign: number;
}

interface ActivityEntry {
  id: string;
  createdAt: string;
  tenantId: string;
  branch: string;
  action: string;
  details: string | null;
  userName: string | null;
  actorRole: string | null;
}

const ACTION_LABEL: Record<string, string> = {
  SIGN: "Signed",
  UPLOAD: "Upload",
  STATUS_CHANGE: "Status change",
  LOGIN: "Signed in",
  LOGOUT: "Signed out",
  LOGIN_FAILED: "Failed sign-in",
  DRIVER_CREATE: "Driver added",
  DRIVER_UPDATE: "Driver updated",
  DRIVER_DELETE: "Driver removed",
  CONFIG_UPDATE: "Settings changed",
  PASSWORD_CHANGE: "Password changed",
  USERNAME_CHANGE: "Username changed",
  ACCOUNT_UPDATE: "Account updated",
  ACCOUNT_CREATE: "Account created",
  ACCOUNT_DEACTIVATE: "Account deactivated",
  ACCOUNT_REACTIVATE: "Account reactivated",
  EXPORT: "Export",
  FILE_DELETE: "File deleted",
  SCOPE_SWITCH: "Switched branch",
};
const ROLE_LABEL: Record<string, string> = { ADMIN: "Office", DRIVER: "Driver", COMPANY_ADMIN: "Company admin" };
const actionLabel = (a: string) => ACTION_LABEL[a] ?? a.charAt(0) + a.slice(1).toLowerCase().replace(/_/g, " ");

const input =
  "h-8 px-2 text-xs font-mono bg-ink-card border border-ink-border rounded text-ink-black focus:outline-none focus:border-ink-green";

/** Switch to a branch and open its dashboard. */
async function openBranch(tenantId: string) {
  const res = await fetch("/api/admin/scopes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId }),
  });
  if (res.ok) window.location.href = "/dashboard";
}

export default function MyBranchesPage() {
  const [tab, setTab] = useState<"overview" | "activity">("overview");

  useEffect(() => {
    const t = setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("tab") === "activity") setTab("activity");
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const choose = (next: "overview" | "activity") => {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "activity") url.searchParams.set("tab", "activity");
    else for (const k of ["tab", "branch", "action", "from", "to", "page", "size"]) url.searchParams.delete(k);
    window.history.replaceState(window.history.state, "", url.toString());
  };

  return (
    <div className="max-w-6xl">
      <div className="mb-5">
        <h1 className="font-mono text-lg font-medium text-ink-black">My branches</h1>
        <p className="text-sm text-ink-muted font-mono mt-1">
          Every branch allocated to you, side by side. Open a branch to work in it.
        </p>
      </div>
      <div className="flex gap-1 mb-5" role="tablist" aria-label="View">
        {(["overview", "activity"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => choose(t)}
            className={`act ${tab === t ? "act-primary" : ""}`}
          >
            {t === "overview" ? "Today" : "Activity"}
          </button>
        ))}
      </div>
      {tab === "overview" ? <Overview /> : <Activity />}
    </div>
  );
}

function Overview() {
  const [branches, setBranches] = useState<BranchSummary[] | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetch(`/api/company/overview?tzOffset=${new Date().getTimezoneOffset()}`)
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Could not load your branches");
          setBranches(data.branches);
          setViewing(data.viewingTenantId);
          setError("");
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Network error")),
    []
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  if (error && !branches) return <p className="text-sm font-mono text-ink-red">{error}</p>;
  if (!branches) return <p className="text-sm font-mono text-ink-muted py-8 text-center">Loading…</p>;
  if (branches.length === 0) {
    return (
      <div className="bg-ink-card border border-ink-border rounded px-5 py-8 text-center">
        <p className="text-sm font-mono text-ink-black">No branches are allocated to you yet.</p>
        <p className="text-xs font-mono text-ink-muted mt-1">Ask your Signex administrator to allocate the branch admins you oversee.</p>
      </div>
    );
  }

  const total = (k: keyof BranchSummary) => branches.reduce((n, b) => n + (b[k] as number), 0);
  const headline: [string, keyof BranchSummary][] = [
    ["Delivered today", "deliveredToday"],
    ["Stops remaining", "remainingStops"],
    ["Drivers on the road", "driversOnRoad"],
    ["Emails to fix", "emailsToFix"],
  ];

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {headline.map(([label, k]) => (
          <div key={k} className="bg-ink-card border border-ink-border rounded px-4 py-3">
            <p className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">{label}</p>
            <p className="text-2xl font-mono text-ink-black mt-1">{total(k)}</p>
            <p className="text-[11px] font-mono text-ink-muted">across {branches.length} branch{branches.length === 1 ? "" : "es"}</p>
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
        {branches.map((b) => {
          const todo = b.emailsToFix + b.courierAttention + b.awaitingApproval + b.creditNotesToReview;
          const row = (label: string, value: number, alert = false) => (
            <div className="flex items-center justify-between py-1">
              <span className="text-xs font-mono text-ink-muted">{label}</span>
              <span className={`text-sm font-mono ${alert && value > 0 ? "text-ink-red" : "text-ink-black"}`}>{value}</span>
            </div>
          );
          return (
            <section key={b.tenantId} className="bg-ink-card border border-ink-border rounded">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-ink-border">
                <h2 className="font-mono text-sm text-ink-black flex-1 min-w-0 truncate">{b.name}</h2>
                {viewing === b.tenantId && <StatusBadge tone="green">Viewing</StatusBadge>}
                {todo > 0 && <StatusBadge tone="amber">{todo} to do</StatusBadge>}
              </div>
              <div className="px-4 py-2">
                {row("Delivered today", b.deliveredToday)}
                {row("Stops remaining", b.remainingStops)}
                {row("Active trip sheets", b.activeSheets)}
                {row("Drivers on the road", b.driversOnRoad)}
                {row("Closed out today", b.closedOutToday)}
              </div>
              <div className="px-4 py-2 border-t border-ink-border">
                {row("Emails to fix", b.emailsToFix, true)}
                {row("Courier sheets needing the office", b.courierAttention, true)}
                {row("Collections pending", b.collectionsPending)}
                {row("Credit returns awaiting approval", b.awaitingApproval, true)}
                {row("Credit notes to review", b.creditNotesToReview, true)}
                {row("Credit notes ready to sign", b.creditNotesToSign)}
              </div>
              <div className="px-4 py-3 border-t border-ink-border">
                <button
                  type="button"
                  className="act act-primary"
                  disabled={opening !== null}
                  onClick={async () => {
                    setOpening(b.tenantId);
                    await openBranch(b.tenantId);
                    setOpening(null);
                  }}
                >
                  {opening === b.tenantId ? "Opening…" : viewing === b.tenantId ? "Go to dashboard" : "Open branch"}
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

interface ActivityView {
  branch: string;
  action: string;
  from: string;
  to: string;
  page: number;
  size: number;
}

const EMPTY_VIEW: ActivityView = { branch: "", action: "", from: "", to: "", page: 1, size: 25 };

function Activity() {
  const [view, setView] = useState<ActivityView | null>(null);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [branches, setBranches] = useState<{ tenantId: string; name: string }[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const seq = useRef(0);

  // The URL's filters, once, after mount.
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams(window.location.search);
      const page = Number.parseInt(p.get("page") ?? "", 10);
      const size = Number.parseInt(p.get("size") ?? "", 10);
      setView({
        branch: p.get("branch") ?? "",
        action: p.get("action") ?? "",
        from: p.get("from") ?? "",
        to: p.get("to") ?? "",
        page: page > 0 ? page : 1,
        size: [25, 50, 100].includes(size) ? size : 25,
      });
    }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!view) return;
    const params = new URLSearchParams({ tab: "activity" });
    if (view.branch) params.set("branch", view.branch);
    if (view.action) params.set("action", view.action);
    if (view.from) params.set("from", view.from);
    if (view.to) params.set("to", view.to);
    if (view.page > 1) params.set("page", String(view.page));
    if (view.size !== 25) params.set("size", String(view.size));
    window.history.replaceState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);

    params.delete("tab");
    params.set("size", String(view.size));
    params.set("tzOffset", String(new Date().getTimezoneOffset()));
    const id = ++seq.current;
    setLoading(true);
    fetch(`/api/company/activity?${params.toString()}`)
      .then(async (res) => {
        const data = await res.json();
        if (id !== seq.current) return;
        if (!res.ok) {
          // A branch taken away since the link was made: show them all.
          if (res.status === 404 && view.branch) {
            setView({ ...view, branch: "", page: 1 });
            return;
          }
          throw new Error(data.error || "Could not load activity");
        }
        setEntries(data.entries);
        setTotal(data.total);
        setCapped(data.capped);
        setBranches(data.branches);
        setActions(data.actions);
        setError("");
        if (data.page !== view.page) setView({ ...view, page: data.page });
      })
      .catch((e) => id === seq.current && setError(e instanceof Error ? e.message : "Network error"))
      .finally(() => id === seq.current && setLoading(false));
  }, [view]);

  const v = view ?? EMPTY_VIEW;
  const change = (patch: Partial<ActivityView>) => setView({ ...v, ...patch, page: patch.page ?? 1 });

  return (
    <div className="bg-ink-card border border-ink-border rounded">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-border">
        <select aria-label="Branch" value={v.branch} onChange={(e) => change({ branch: e.target.value })} className={input}>
          <option value="">All branches</option>
          {branches.map((b) => (
            <option key={b.tenantId} value={b.tenantId}>{b.name}</option>
          ))}
        </select>
        <select aria-label="What happened" value={v.action} onChange={(e) => change({ action: e.target.value })} className={input}>
          <option value="">Everything</option>
          {actions.map((a) => (
            <option key={a} value={a}>{actionLabel(a)}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-xs font-mono text-ink-muted">
          From
          <input type="date" value={v.from} onChange={(e) => change({ from: e.target.value })} className={input} />
        </label>
        <label className="flex items-center gap-1.5 text-xs font-mono text-ink-muted">
          To
          <input type="date" value={v.to} onChange={(e) => change({ to: e.target.value })} className={input} />
        </label>
        {(v.branch || v.action || v.from || v.to) && (
          <button type="button" className="act" onClick={() => setView({ ...EMPTY_VIEW, size: v.size })}>
            Clear
          </button>
        )}
      </div>

      {error && <p className="px-4 py-3 text-sm font-mono text-ink-red">{error}</p>}
      {loading && entries.length === 0 ? (
        <p className="px-4 py-8 text-sm font-mono text-ink-muted text-center">Loading…</p>
      ) : capped ? (
        <p className="px-4 py-8 text-sm font-mono text-ink-muted text-center">
          That page is too far back. Set a date range to see older activity.
        </p>
      ) : entries.length === 0 ? (
        <p className="px-4 py-8 text-sm font-mono text-ink-muted text-center">Nothing happened in these branches for this filter.</p>
      ) : (
        <ul className={`divide-y divide-ink-border ${loading ? "opacity-60" : ""}`}>
          {entries.map((e) => {
            const at = new Date(e.createdAt);
            return (
              <li key={e.id} className="px-4 py-2.5 grid grid-cols-[6.5rem_1fr] sm:grid-cols-[9rem_8rem_1fr] gap-x-3 gap-y-0.5 text-sm font-mono">
                <span className="text-[11px] text-ink-muted leading-5">
                  {at.toLocaleDateString("en-ZA", { day: "2-digit", month: "short" })}{" "}
                  {at.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="hidden sm:block text-[11px] text-ink-muted leading-5 truncate">{e.branch}</span>
                <span className="min-w-0">
                  <span className="text-ink-black">{actionLabel(e.action)}</span>
                  {e.userName && (
                    <span className="text-ink-muted">
                      {" · "}
                      {e.userName}
                      {e.actorRole && ROLE_LABEL[e.actorRole] ? ` (${ROLE_LABEL[e.actorRole]})` : ""}
                    </span>
                  )}
                  <span className="sm:hidden text-[11px] text-ink-muted"> · {e.branch}</span>
                  {e.details && <span className="block text-[11px] text-ink-muted truncate">{e.details}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Pager
        page={v.page}
        pageSize={v.size}
        total={total}
        onPage={(page) => setView({ ...v, page })}
        onPageSize={(size) => setView({ ...v, size, page: 1 })}
        disabled={loading}
      />
    </div>
  );
}
