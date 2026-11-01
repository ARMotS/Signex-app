"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Pager from "@/components/ui/Pager";
import { StatusBadge } from "@/components/ui/Chips";
import { relativeTime } from "@/lib/relative-time";
import { deviceLabel } from "@/lib/device-label";

/**
 * Devices: where each account is signed in, and signing a device out from
 * here. Everyone sees their own; a branch admin also its drivers; a company
 * admin also its allocated admins and their drivers; the super admin
 * everyone. The server decides who is listed and checks every sign-out.
 */

interface DeviceSession {
  id: string;
  browser: string | null;
  os: string | null;
  deviceType: string | null;
  signedInAt: string;
  lastSeenAt: string;
  live: boolean;
  endedAt: string | null;
  endedReason: string | null;
  isCurrent: boolean;
  ipAddress?: string | null;
}

interface AccountDevices {
  kind: "admin" | "driver";
  id: string;
  name: string;
  username: string | null;
  role: "admin" | "driver" | "super_admin" | "company_admin";
  branchTenantId: string | null;
  branch: string | null;
  companyName: string | null;
  isSelf: boolean;
  limit: number;
  liveCount: number;
  devices: DeviceSession[];
  recent: DeviceSession[];
}

interface View {
  q: string;
  branch: string;
  all: boolean;
  page: number;
  size: number;
}

const DEFAULT_VIEW: View = { q: "", branch: "", all: false, page: 1, size: 25 };
const SIZES = [10, 25, 50] as const;

const ROLE_LABEL: Record<AccountDevices["role"], string> = {
  admin: "Office",
  driver: "Driver",
  company_admin: "Company admin",
  super_admin: "Super admin",
};

const ENDED: Record<string, string> = {
  logout: "Logged out",
  evicted: "Signed out by a newer sign-in",
  replaced: "Replaced by a new phone",
  password_reset: "Password reset",
  deactivated: "Account deactivated",
  role_change: "Role changed",
  signed_out_remotely: "Signed out from the Devices page",
  expired: "Session expired",
};

const input =
  "h-8 px-2 text-xs font-mono bg-ink-card border border-ink-border rounded text-ink-black focus:outline-none focus:border-ink-green";

const deviceName = (s: DeviceSession) => deviceLabel(s);

function DeviceIcon({ type }: { type: string | null }) {
  return type === "phone" || type === "tablet" ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6" y="2" width="12" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export default function DevicesPage() {
  const [view, setView] = useState<View | null>(null);
  const [typed, setTyped] = useState("");
  const [accounts, setAccounts] = useState<AccountDevices[]>([]);
  const [total, setTotal] = useState(0);
  const [signedInNow, setSignedInNow] = useState(0);
  const [branches, setBranches] = useState<{ tenantId: string; name: string }[]>([]);
  const [historyDays, setHistoryDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const seq = useRef(0);

  // The URL's view, once, after mount.
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams(window.location.search);
      const page = Number.parseInt(p.get("page") ?? "", 10);
      const size = Number.parseInt(p.get("size") ?? "", 10);
      const v: View = {
        q: (p.get("q") ?? "").slice(0, 100),
        branch: p.get("branch") ?? "",
        all: p.get("all") === "1",
        page: page > 0 ? page : 1,
        size: (SIZES as readonly number[]).includes(size) ? size : 25,
      };
      setView(v);
      setTyped(v.q);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const change = useCallback((patch: Partial<View>) => {
    setView((v) => ({ ...(v ?? DEFAULT_VIEW), ...patch, page: patch.page ?? 1 }));
  }, []);

  useEffect(() => {
    if (!view || typed === view.q) return;
    const t = setTimeout(() => change({ q: typed }), 300);
    return () => clearTimeout(t);
  }, [typed, view, change]);

  const load = useCallback(async (v: View) => {
    const params = new URLSearchParams();
    if (v.q.trim()) params.set("q", v.q.trim());
    if (v.branch) params.set("branch", v.branch);
    if (v.all) params.set("all", "1");
    if (v.page > 1) params.set("page", String(v.page));
    if (v.size !== 25) params.set("size", String(v.size));
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    params.set("size", String(v.size));
    const id = ++seq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/devices?${params}`);
      const data = await res.json();
      if (id !== seq.current) return;
      if (!res.ok) throw new Error(data.error || "Could not load devices");
      setAccounts(data.accounts);
      setTotal(data.total);
      setSignedInNow(data.signedInNow);
      setBranches(data.branches);
      setHistoryDays(data.historyDays);
      setError("");
      if (data.page !== v.page) setView({ ...v, page: data.page });
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : "Network error");
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view) void load(view);
  }, [view, load]);

  const signOut = async (account: AccountDevices, s: DeviceSession) => {
    setBusy(s.id);
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/devices/${s.id}/sign-out`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 404 ? "That device is no longer one you can manage." : data.error || "That did not work");
      } else {
        setNotice(`${deviceName(s)} signed out${account.isSelf ? "" : ` for ${account.name}`}. It needs to sign in again.`);
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(null);
      setConfirming(null);
      if (view) void load(view);
    }
  };

  const v = view ?? DEFAULT_VIEW;

  return (
    <div className="max-w-5xl">
      <div className="mb-5">
        <h1 className="font-mono text-lg font-medium text-ink-black">Devices</h1>
        <p className="text-sm text-ink-muted font-mono mt-1">
          Where each account is signed in. Sign a device out if it is lost, shared or no longer used — it will need
          the password to get back in.
        </p>
      </div>

      {notice && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-ink-green-dim rounded border border-ink-green/20">
          <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
          <span className="text-xs font-mono text-ink-green">{notice}</span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-red-500/10 rounded border border-red-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          <span className="text-xs font-mono text-red-400">{error}</span>
        </div>
      )}

      <div className="bg-ink-card border border-ink-border rounded">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-ink-border">
          <input
            type="search"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search name, username or branch…"
            aria-label="Search accounts"
            className={`${input} flex-1 min-w-[12rem]`}
          />
          {branches.length > 1 && (
            <select aria-label="Branch" value={v.branch} onChange={(e) => change({ branch: e.target.value })} className={input}>
              <option value="">All branches</option>
              {branches.map((b) => (
                <option key={b.tenantId} value={b.tenantId}>{b.name}</option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1.5 text-xs font-mono text-ink-muted">
            <input type="checkbox" checked={v.all} onChange={(e) => change({ all: e.target.checked })} />
            Include accounts with no devices
          </label>
          <span className="text-xs font-mono text-ink-muted ml-auto">{signedInNow} signed in now</span>
        </div>

        {loading && accounts.length === 0 ? (
          <p className="px-4 py-8 text-sm font-mono text-ink-muted text-center">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="px-4 py-8 text-sm font-mono text-ink-muted text-center">No devices for this search.</p>
        ) : (
          <ul className={`divide-y divide-ink-border ${loading ? "opacity-60" : ""}`}>
            {accounts.map((a) => (
              <li key={`${a.kind}:${a.id}`} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-mono text-ink-black">{a.name}</span>
                  {a.username && <span className="text-xs font-mono text-ink-muted">@{a.username}</span>}
                  {a.isSelf && <StatusBadge tone="green">You</StatusBadge>}
                  <span className="text-[11px] font-mono text-ink-muted">
                    {ROLE_LABEL[a.role]}
                    {a.branch ? ` · ${a.branch}` : a.companyName ? ` · ${a.companyName}` : ""}
                  </span>
                  <span className={`ml-auto text-[11px] font-mono ${a.limit > 1 && a.liveCount >= a.limit ? "text-ink-amber" : "text-ink-muted"}`}>
                    {a.liveCount} of {a.limit} device{a.limit === 1 ? "" : "s"}
                  </span>
                </div>

                {a.devices.length === 0 ? (
                  <p className="text-xs font-mono text-ink-muted mt-2">Not signed in anywhere.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {a.devices.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-ink-border px-3 py-2">
                        <span className="text-ink-muted"><DeviceIcon type={s.deviceType} /></span>
                        <span className="flex-1 min-w-[12rem]">
                          <span className="block text-sm font-mono text-ink-black">
                            {deviceName(s)}
                            {s.isCurrent && <span className="ml-2"><StatusBadge tone="green">This device</StatusBadge></span>}
                          </span>
                          <span className="block text-[11px] font-mono text-ink-muted">
                            Signed in {when(s.signedInAt)} · active {relativeTime(s.lastSeenAt)}
                            {s.ipAddress !== undefined && ` · IP ${s.ipAddress ?? "unknown"}`}
                          </span>
                        </span>
                        {!s.isCurrent &&
                          (confirming === s.id ? (
                            <span className="flex gap-2">
                              <button type="button" className="act act-danger" disabled={busy !== null} onClick={() => signOut(a, s)}>
                                {busy === s.id ? "Signing out…" : "Sign it out"}
                              </button>
                              <button type="button" className="act" onClick={() => setConfirming(null)}>Cancel</button>
                            </span>
                          ) : (
                            <button type="button" className="act" disabled={busy !== null} onClick={() => setConfirming(s.id)}>
                              Sign out
                            </button>
                          ))}
                      </li>
                    ))}
                  </ul>
                )}

                {a.recent.length > 0 && (
                  <details className="mt-2">
                    <summary className="text-[11px] font-mono text-ink-muted cursor-pointer select-none">
                      Recently signed out ({a.recent.length}, last {historyDays} days)
                    </summary>
                    <ul className="mt-1.5 space-y-1">
                      {a.recent.map((s) => (
                        <li key={s.id} className="flex items-center gap-2 text-[11px] font-mono text-ink-muted pl-1">
                          <DeviceIcon type={s.deviceType} />
                          <span className="text-ink-black">{deviceName(s)}</span>
                          <span>
                            · {ENDED[s.endedReason ?? ""] ?? "Signed out"} {s.endedAt ? when(s.endedAt) : ""}
                            {s.ipAddress !== undefined && s.ipAddress ? ` · IP ${s.ipAddress}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        <Pager
          page={v.page}
          pageSize={v.size}
          total={total}
          onPage={(page) => change({ page })}
          onPageSize={(size) => change({ size })}
          sizes={SIZES}
          disabled={loading}
        />
      </div>
    </div>
  );
}
