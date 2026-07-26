"use client";

import { useEffect, useState } from "react";

/**
 * SUPER_ADMIN scope switcher.
 *
 * Renders nothing for ADMIN and DRIVER sessions. The active scope is stored in
 * the signed session cookie server-side; this component only calls
 * POST /api/admin/scopes and reloads, so nothing here is trusted as a scope
 * value on subsequent requests.
 */

interface Scope {
  tenantId: string;
  name: string;
  slug: string;
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

export default function ScopeSwitcher({ role }: { role: string | null }) {
  const [scopes, setScopes] = useState<Scope[] | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);

  const isSuper = role === "super_admin";

  useEffect(() => {
    if (!isSuper) return;
    fetch("/api/admin/scopes")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setScopes(data.scopes))
      .catch(() => {});
  }, [isSuper]);

  if (!isSuper || !scopes) return null;

  const active = scopes.find((s) => s.isActive);
  const viewingOther = active && !active.isHome;

  const switchTo = async (tenantId: string | null) => {
    setSwitching(tenantId ?? "home");
    try {
      const res = await fetch("/api/admin/scopes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenantId }),
      });
      if (res.ok) {
        // Full reload so every page refetches under the new scope.
        window.location.reload();
        return;
      }
    } catch {
      // fall through
    }
    setSwitching(null);
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
            Viewing scope
          </span>
          <span
            className={`block text-xs font-mono truncate ${
              viewingOther ? "text-ink-amber" : "text-sidebar-text-active"
            }`}
          >
            {active?.isHome ? "My own scope" : active?.name ?? "Unknown"}
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
        <div className="mt-2 space-y-1 max-h-72 overflow-y-auto">
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
 * ADMIN's scope, so it is never ambiguous whose data is on screen.
 */
export function ScopeBanner({ role }: { role: string | null }) {
  const [scope, setScope] = useState<{ name: string } | null>(null);

  useEffect(() => {
    if (role !== "super_admin") return;
    fetch("/api/admin/scopes")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data?.isViewingOtherScope) return;
        const active = data.scopes.find((s: Scope) => s.isActive);
        if (active) setScope({ name: active.name });
      })
      .catch(() => {});
  }, [role]);

  if (!scope) return null;

  const reset = async () => {
    await fetch("/api/admin/scopes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: null }),
    });
    window.location.reload();
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-ink-amber/10 border-b border-ink-amber/30">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-amber shrink-0">
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      </svg>
      <p className="flex-1 text-xs font-mono text-ink-black">
        Viewing <span className="font-semibold">{scope.name}</span>&apos;s data as
        SUPER_ADMIN. Changes you make apply to their scope.
      </p>
      <button
        onClick={reset}
        className="text-xs font-mono px-3 py-1 rounded bg-ink-black text-white hover:bg-ink-black/80 transition-colors shrink-0"
      >
        Back to my scope
      </button>
    </div>
  );
}
