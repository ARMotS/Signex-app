"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/ui/Chips";
import Pager from "@/components/ui/Pager";
import { relativeTime } from "@/lib/relative-time";

/**
 * Who uses Signex: per branch, and per account within it, over the last 7 or
 * 30 days. A COMPANY_ADMIN sees its allocated branches; the SUPER_ADMIN every
 * branch, grouped by company. Read-only, and no IP or device detail.
 */

interface UsageAccount {
  id: string;
  name: string;
  username: string | null;
  role: "ADMIN" | "DRIVER";
  active: boolean;
  lastActiveAt: string | null;
  devicesNow: number;
  signIns: number;
  signatures: number;
  actions: number;
}

interface BranchUsage {
  tenantId: string;
  name: string;
  companyId: string | null;
  companyName: string | null;
  accounts: UsageAccount[];
  totals: {
    accounts: number;
    activeUsers: number;
    devicesNow: number;
    signIns: number;
    deliveriesSigned: number;
    actions: number;
    lastActiveAt: string | null;
  };
}

const th = "px-3 py-2 text-[11px] font-mono font-normal text-ink-muted uppercase tracking-wide";
const td = "px-3 py-2.5 text-sm font-mono";

export default function UsagePage() {
  const [days, setDays] = useState(7);
  const [branches, setBranches] = useState<BranchUsage[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = useCallback((d: number) => {
    setLoading(true);
    fetch(`/api/usage?days=${d}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not load usage");
        setBranches(data.branches);
        setError("");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Network error"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(days);
  }, [days, load]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Grouped by company (one group for a company admin); unassigned last.
  const groups = new Map<string, { name: string; branches: BranchUsage[] }>();
  for (const b of branches ?? []) {
    const key = b.companyId ?? "";
    const g = groups.get(key) ?? { name: b.companyName ?? "No company", branches: [] };
    g.branches.push(b);
    groups.set(key, g);
  }
  const ordered = [...groups.entries()].sort(([a, x], [b, y]) => (a === "" ? 1 : b === "" ? -1 : x.name.localeCompare(y.name)));

  return (
    <div className="max-w-6xl">
      <div className="flex flex-wrap items-start gap-3 mb-5">
        <div className="flex-1 min-w-[16rem]">
          <h1 className="font-mono text-lg font-medium text-ink-black">Usage</h1>
          <p className="text-sm text-ink-muted font-mono mt-1">
            Who is using Signex in each branch: sign-ins, deliveries signed and activity. Open a branch for its people.
          </p>
        </div>
        <div className="flex gap-1" role="tablist" aria-label="Period">
          {[7, 30].map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={days === d}
              onClick={() => setDays(d)}
              className={`act ${days === d ? "act-primary" : ""}`}
            >
              Last {d} days
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm font-mono text-ink-red mb-3">{error}</p>}
      {!branches ? (
        <p className="text-sm font-mono text-ink-muted py-8 text-center">{loading ? "Loading…" : ""}</p>
      ) : branches.length === 0 ? (
        <div className="bg-ink-card border border-ink-border rounded px-5 py-8 text-center">
          <p className="text-sm font-mono text-ink-black">No branches to show yet.</p>
        </div>
      ) : (
        <div className={`space-y-6 ${loading ? "opacity-60" : ""}`}>
          {ordered.map(([key, g]) => (
            <section key={key || "none"}>
              {groups.size > 1 && <p className="text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-2">{g.name}</p>}
              <div className="bg-ink-card border border-ink-border rounded overflow-x-auto">
                <table className="w-full min-w-[44rem]">
                  <thead>
                    <tr className="border-b border-ink-border text-left">
                      <th className={th}>Branch</th>
                      <th className={`${th} text-right`}>Active users</th>
                      <th className={`${th} text-right`}>Sign-ins</th>
                      <th className={`${th} text-right`}>Deliveries signed</th>
                      <th className={`${th} text-right`}>Actions</th>
                      <th className={`${th} text-right`}>Signed in now</th>
                      <th className={th}>Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.branches.map((b) => (
                      <Fragment key={b.tenantId}>
                        <tr
                          className="border-b border-ink-border last:border-0 hover:bg-ink-surface/50 cursor-pointer"
                          onClick={() => toggle(b.tenantId)}
                          aria-expanded={open.has(b.tenantId)}
                        >
                          <td className={`${td} text-ink-black`}>
                            <span className="text-ink-muted mr-1.5">{open.has(b.tenantId) ? "▾" : "▸"}</span>
                            {b.name}
                          </td>
                          <td className={`${td} text-right`}>
                            {b.totals.activeUsers}
                            <span className="text-ink-muted"> / {b.totals.accounts}</span>
                          </td>
                          <td className={`${td} text-right`}>{b.totals.signIns}</td>
                          <td className={`${td} text-right`}>{b.totals.deliveriesSigned}</td>
                          <td className={`${td} text-right`}>{b.totals.actions}</td>
                          <td className={`${td} text-right`}>{b.totals.devicesNow}</td>
                          <td className={`${td} text-ink-muted`}>{relativeTime(b.totals.lastActiveAt)}</td>
                        </tr>
                        {open.has(b.tenantId) && (
                          <tr className="border-b border-ink-border bg-ink-surface/40">
                            <td colSpan={7} className="px-3 py-3">
                              <Accounts accounts={b.accounts} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** A branch's people, ten at a time: a depot's drivers make a long list. */
const ACCOUNTS_PAGE = 10;

function Accounts({ accounts }: { accounts: UsageAccount[] }) {
  const [page, setPage] = useState(1);
  const last = Math.max(1, Math.ceil(accounts.length / ACCOUNTS_PAGE));
  const shown = Math.min(page, last);
  if (accounts.length === 0) return <p className="text-xs font-mono text-ink-muted">No accounts in this branch.</p>;
  return (
    <>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Account</th>
            <th className={th}>Role</th>
            <th className={`${th} text-right`}>Sign-ins</th>
            <th className={`${th} text-right`}>Signatures</th>
            <th className={`${th} text-right`}>Actions</th>
            <th className={`${th} text-right`}>Devices now</th>
            <th className={th}>Last active</th>
          </tr>
        </thead>
        <tbody>
          {accounts.slice((shown - 1) * ACCOUNTS_PAGE, shown * ACCOUNTS_PAGE).map((a) => (
            <tr key={a.id} className="border-t border-ink-border/60">
              <td className={td}>
                <span className="text-ink-black">{a.name}</span>
                {a.username && <span className="text-[11px] text-ink-muted"> @{a.username}</span>}
                {!a.active && (
                  <span className="ml-2">
                    <StatusBadge tone="amber">Deactivated</StatusBadge>
                  </span>
                )}
              </td>
              <td className={`${td} text-ink-muted`}>{a.role === "ADMIN" ? "Office" : "Driver"}</td>
              <td className={`${td} text-right`}>{a.signIns}</td>
              <td className={`${td} text-right`}>{a.signatures}</td>
              <td className={`${td} text-right`}>{a.actions}</td>
              <td className={`${td} text-right`}>{a.devicesNow}</td>
              <td className={`${td} text-ink-muted`}>{relativeTime(a.lastActiveAt, "Never signed in")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Pager page={shown} pageSize={ACCOUNTS_PAGE} total={accounts.length} onPage={setPage} />
    </>
  );
}
