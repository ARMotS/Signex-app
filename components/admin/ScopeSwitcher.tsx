"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Scope switcher: every scope for a SUPER_ADMIN, the allocated branches for a
 * COMPANY_ADMIN (the server lists nothing else for it, and has no "own
 * scope" entry — a company admin's home holds no data).
 *
 * Renders nothing for ADMIN and DRIVER sessions. The active scope is stored in
 * the signed session cookie server-side; this component only calls
 * POST /api/admin/scopes and reloads, so nothing here is trusted as a scope
 * value on subsequent requests.
 */

interface Scope {
  tenantId: string;
  name: string;
  slug: string | null;
  isHome: boolean;
  isActive: boolean;
  admins: { id: string; name: string; email: string }[];
  counts: {
    drivers: number;
    contacts: number;
    tripSheets: number;
    stops: number;
  };
}

export interface ScopesData {
  isViewingOtherScope: boolean;
  scopes: Scope[];
}

/**
 * GET /api/admin/scopes, once, for the accounts that can switch. The layout
 * holds it and hands it to the switcher, the banner and the branch picker, so
 * a page load costs one request rather than one per component.
 */
export function useScopes(role: string | null): ScopesData | null {
  const [data, setData] = useState<ScopesData | null>(null);
  const canSwitch = role === "super_admin" || role === "company_admin";
  useEffect(() => {
    if (!canSwitch) return;
    fetch("/api/admin/scopes")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData({ isViewingOtherScope: !!d.isViewingOtherScope, scopes: d.scopes }))
      .catch(() => {});
  }, [canSwitch]);
  return canSwitch ? data : null;
}

/** Switch scope (null = own scope), then reload so every page refetches under it. */
async function switchScope(tenantId: string | null): Promise<boolean> {
  try {
    const res = await fetch("/api/admin/scopes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    if (res.ok) {
      window.location.reload();
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}

export default function ScopeSwitcher({ role, data }: { role: string | null; data: ScopesData | null }) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const scopes = data?.scopes;
  if (!scopes) return null;

  const isCompanyAdmin = role === "company_admin";
  const active = scopes.find((s) => s.isActive);
  const viewingOther = active && !active.isHome;

  const switchTo = async (tenantId: string | null) => {
    setSwitching(tenantId ?? "home");
    if (!(await switchScope(tenantId))) setSwitching(null);
  };

  return (
    <div className="px-3 py-3 border-t border-white/5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 rounded text-left hover:bg-white/5 transition-colors"
      >
        <span className={viewingOther ? "text-ink-amber" : "text-sidebar-text"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7V5a2 2 0 0 1 2-2h2" />
            <path d="M17 3h2a2 2 0 0 1 2 2v2" />
            <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
            <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[10px] font-mono uppercase tracking-wide text-sidebar-text">
            {isCompanyAdmin ? "Viewing branch" : "Viewing scope"}
          </span>
          <span
            className={`block text-xs font-mono truncate ${
              viewingOther ? "text-ink-amber" : "text-sidebar-text-active"
            }`}
          >
            {active?.isHome
              ? "My own scope"
              : active?.name ?? (isCompanyAdmin ? "Choose a branch" : "Unknown")}
          </span>
        </span>
        <span className="text-sidebar-text">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={open ? "rotate-180 transition-transform" : "transition-transform"}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {open && (
        <div
          ref={(el) => el?.scrollIntoView({ block: "nearest" })}
          className="mt-2 space-y-1 max-h-[min(18rem,50dvh)] overflow-y-auto overscroll-contain"
        >
          {scopes.map((scope) => {
            const owner = scope.admins[0];
            return (
              <button
                key={scope.tenantId}
                disabled={switching !== null}
                onClick={() => switchTo(scope.isHome ? null : scope.tenantId)}
                className={`w-full text-left px-3 py-2 rounded transition-colors disabled:opacity-50 ${
                  scope.isActive
                    ? "bg-white/8"
                    : "hover:bg-white/5"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      scope.isActive ? "bg-ink-green" : "bg-white/20"
                    }`}
                  />
                  <span className="text-xs font-mono text-sidebar-text-active truncate">
                    {scope.isHome ? "My own scope" : scope.name}
                  </span>
                </div>
                <div className="pl-3.5 mt-0.5">
                  {owner && !scope.isHome && (
                    <p className="text-[10px] text-sidebar-text truncate">
                      {owner.email}
                    </p>
                  )}
                  <p className="text-[10px] text-sidebar-text font-mono">
                    {scope.counts.drivers}d · {scope.counts.contacts}c ·{" "}
                    {scope.counts.tripSheets}ts
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Persistent banner shown while a SUPER_ADMIN is operating inside another
 * ADMIN's scope, or a COMPANY_ADMIN inside one of its branches, so it is
 * never ambiguous whose data is on screen. The company admin's carries the
 * branch picker too: on a phone the sidebar switcher is hidden.
 */
export function ScopeBanner({ role, data }: { role: string | null; data: ScopesData | null }) {
  const [switching, setSwitching] = useState(false);
  if (!data?.isViewingOtherScope) return null;
  const active = data.scopes.find((s) => s.isActive);
  if (!active) return null;

  const go = async (tenantId: string | null) => {
    setSwitching(true);
    if (!(await switchScope(tenantId))) setSwitching(false);
  };

  if (role === "company_admin") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 bg-ink-green-dim border-b border-ink-green/20">
        <span className="w-1.5 h-1.5 rounded-full bg-ink-green shrink-0" />
        <p className="flex-1 min-w-[12rem] text-xs font-mono text-ink-black">
          Viewing <span className="font-semibold">{active.name}</span>. You are working as this branch&apos;s
          office: changes apply to {active.name} only.
        </p>
        {data.scopes.length > 1 && (
          <select
            aria-label="Switch branch"
            value={active.tenantId}
            disabled={switching}
            onChange={(e) => go(e.target.value)}
            className="h-6 px-2 text-[11px] font-mono bg-white border border-ink-border rounded text-ink-black shrink-0"
          >
            {data.scopes.map((s) => (
              <option key={s.tenantId} value={s.tenantId}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }

  if (role !== "super_admin") return null;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-ink-amber/10 border-b border-ink-amber/30">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-amber shrink-0">
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      </svg>
      <p className="flex-1 text-xs font-mono text-ink-black">
        Viewing <span className="font-semibold">{active.name}</span>&apos;s data as
        SUPER_ADMIN. Changes you make apply to their scope.
      </p>
      <button
        onClick={() => go(null)}
        disabled={switching}
        className="text-xs font-mono px-3 py-1 rounded bg-ink-black text-white hover:bg-ink-black/80 transition-colors shrink-0"
      >
        Back to my scope
      </button>
    </div>
  );
}

/**
 * What a COMPANY_ADMIN sees on a branch page while no branch is chosen (or
 * the one it had was taken away): the branches it may open, or, with none
 * allocated yet, who to ask. Rendered by the layout in place of the page, so
 * the page never asks the server for data it would be refused.
 */
export function ChooseBranch({ data }: { data: ScopesData | null }) {
  const [switching, setSwitching] = useState<string | null>(null);
  if (!data) {
    return <div className="text-sm font-mono text-ink-muted py-8 text-center">Loading…</div>;
  }
  const go = async (tenantId: string) => {
    setSwitching(tenantId);
    if (!(await switchScope(tenantId))) setSwitching(null);
  };

  return (
    <div className="max-w-lg mx-auto py-10">
      <h1 className="font-mono text-lg font-medium text-ink-black">Choose a branch</h1>
      {data.scopes.length === 0 ? (
        <>
          <p className="text-sm font-mono text-ink-muted mt-2">
            No branches are allocated to you yet. Ask your Signex administrator to allocate the branch admins you
            oversee. Their branches will appear here.
          </p>
          <Link href="/my-admins" className="act mt-4 inline-flex">
            My admins
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm font-mono text-ink-muted mt-2">
            Pick the branch to work in. You can switch at any time from the sidebar or the bar at the top.
          </p>
          <ul className="mt-5 space-y-2">
            {data.scopes.map((s) => (
              <li key={s.tenantId}>
                <button
                  type="button"
                  disabled={switching !== null}
                  onClick={() => go(s.tenantId)}
                  className="w-full flex items-center gap-3 px-4 py-3 bg-ink-card border border-ink-border rounded text-left hover:border-ink-green transition-colors disabled:opacity-50"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-mono text-ink-black truncate">{s.name}</span>
                    <span className="block text-[11px] font-mono text-ink-muted">
                      {s.counts.drivers} drivers · {s.counts.tripSheets} trip sheets
                    </span>
                  </span>
                  <span className="text-xs font-mono text-ink-green shrink-0">
                    {switching === s.tenantId ? "Opening…" : "Open →"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
