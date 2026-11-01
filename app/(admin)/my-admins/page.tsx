"use client";

import { useCallback, useEffect, useState } from "react";
import UsernameField, { type UsernameStatus } from "@/components/UsernameField";
import { StatusBadge } from "@/components/ui/Chips";
import { validatePassword, PASSWORD_HINT } from "@/lib/credentials";

/**
 * COMPANY_ADMIN: the branch admins allocated to it, with their usernames and
 * passwords to look after. Works whichever branch the switcher points at (or
 * none). The server checks every action against the allocation again; this
 * page only offers what is allocated.
 */

interface MyAdmin {
  id: string;
  name: string;
  username: string | null;
  branch: string;
  active: boolean;
  lastActiveAt: string | null;
}

const input =
  "w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors";
const label = "block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5";

/** "4 min ago", "Yesterday 14:05", "12 Oct 2026" — read on the viewer's clock. */
function lastActive(iso: string | null): string {
  if (!iso) return "Never signed in";
  const at = new Date(iso);
  const mins = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`;
  const time = at.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
  if (mins < 48 * 60) return `Yesterday ${time}`;
  return at.toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" });
}

export default function MyAdminsPage() {
  const [admins, setAdmins] = useState<MyAdmin[] | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editing, setEditing] = useState<{ id: string; mode: "username" | "password" } | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/company/admins")
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Could not load your admins");
          setAdmins(data.admins);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Network error")),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  /** Save one change; reloads on success. Returns whether it worked. */
  const save = async (admin: MyAdmin, body: { username?: string; password?: string }, done: string) => {
    setError("");
    setSuccess("");
    try {
      const res = await fetch(`/api/company/admins/${admin.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 404: the allocation was taken away since the list loaded.
        setError(res.status === 404 ? `${admin.name} is no longer allocated to you.` : data.error || "That did not save");
        if (res.status === 404) await load();
        return false;
      }
      setSuccess(done);
      setEditing(null);
      await load();
      return true;
    } catch {
      setError("Network error");
      return false;
    }
  };

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="font-mono text-lg font-medium text-ink-black">My admins</h1>
        <p className="text-sm text-ink-muted font-mono mt-1">
          The branch admins allocated to you. You can change their usernames and reset their passwords.
        </p>
      </div>

      {success && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-ink-green-dim rounded border border-ink-green/20">
          <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
          <span className="text-xs font-mono text-ink-green">{success}</span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-red-500/10 rounded border border-red-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          <span className="text-xs font-mono text-red-400">{error}</span>
        </div>
      )}

      {admins === null ? (
        <div className="text-sm font-mono text-ink-muted py-8 text-center">{error ? "" : "Loading…"}</div>
      ) : admins.length === 0 ? (
        <div className="bg-ink-card border border-ink-border rounded px-5 py-8 text-center">
          <p className="text-sm font-mono text-ink-black">No branch admins are allocated to you yet.</p>
          <p className="text-xs font-mono text-ink-muted mt-1">
            Ask your Signex administrator to allocate the branch admins you oversee.
          </p>
        </div>
      ) : (
        <div className="bg-ink-card border border-ink-border rounded divide-y divide-ink-border">
          {admins.map((a) => (
            <div key={a.id} className="px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex-1 min-w-[14rem]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-mono text-ink-black">{a.name}</span>
                    {a.username && <span className="text-xs font-mono text-ink-muted">@{a.username}</span>}
                    <StatusBadge tone={a.active ? "green" : "amber"}>{a.active ? "Active" : "Deactivated"}</StatusBadge>
                  </div>
                  <p className="text-[11px] font-mono text-ink-muted mt-1">
                    {a.branch} · Last active: {lastActive(a.lastActiveAt)}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    className="act"
                    onClick={() => setEditing(editing?.id === a.id && editing.mode === "username" ? null : { id: a.id, mode: "username" })}
                  >
                    Change username
                  </button>
                  <button
                    type="button"
                    className="act act-amber"
                    onClick={() => setEditing(editing?.id === a.id && editing.mode === "password" ? null : { id: a.id, mode: "password" })}
                  >
                    Reset password
                  </button>
                </div>
              </div>
              {editing?.id === a.id && editing.mode === "username" && (
                <UsernameForm admin={a} onSave={save} onCancel={() => setEditing(null)} />
              )}
              {editing?.id === a.id && editing.mode === "password" && (
                <PasswordForm admin={a} onSave={save} onCancel={() => setEditing(null)} />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Save = (admin: MyAdmin, body: { username?: string; password?: string }, done: string) => Promise<boolean>;

function UsernameForm({ admin, onSave, onCancel }: { admin: MyAdmin; onSave: Save; onCancel: () => void }) {
  const [username, setUsername] = useState(admin.username ?? "");
  const [status, setStatus] = useState<UsernameStatus>("unchanged");
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mt-4 max-w-md space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const next = username.trim().toLowerCase();
        await onSave(admin, { username: next }, `${admin.name} now signs in as @${next}`);
        setBusy(false);
      }}
    >
      <div>
        <label className={label} htmlFor={`username-${admin.id}`}>New username</label>
        <UsernameField
          id={`username-${admin.id}`}
          value={username}
          onChange={setUsername}
          currentUsername={admin.username}
          onStatusChange={setStatus}
          required
          className={input}
        />
        <p className="text-[11px] font-mono text-ink-muted mt-1.5">
          They sign in with the new username from now on. Their password and devices are unchanged.
        </p>
      </div>
      <div className="flex gap-2">
        <button type="submit" className="act act-primary" disabled={busy || status !== "available"}>
          {busy ? "Saving…" : "Save username"}
        </button>
        <button type="button" className="act" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function PasswordForm({ admin, onSave, onCancel }: { admin: MyAdmin; onSave: Save; onCancel: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const passwordError = password ? validatePassword(password) : null;
  const mismatch = confirm !== "" && confirm !== password;
  const ready = password && !passwordError && confirm === password;

  return (
    <form
      className="mt-4 max-w-md space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await onSave(admin, { password }, `Password reset for ${admin.name} — signed out of every device`);
        setBusy(false);
      }}
    >
      <div className="px-3 py-2 rounded border border-ink-amber/30 bg-ink-amber/10 text-xs font-mono text-ink-black">
        {admin.name} will be signed out on every device at once and must sign in with the new password.
      </div>
      <div>
        <label className={label} htmlFor={`password-${admin.id}`}>New password</label>
        <input
          id={`password-${admin.id}`}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          className={input}
        />
        <p className={`text-[11px] mt-1.5 ${passwordError ? "text-ink-red" : "text-ink-muted"}`}>{passwordError || PASSWORD_HINT}</p>
      </div>
      <div>
        <label className={label} htmlFor={`confirm-${admin.id}`}>Type it again</label>
        <input
          id={`confirm-${admin.id}`}
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          className={input}
        />
        {mismatch && <p className="text-[11px] mt-1.5 text-ink-red">The two passwords are different.</p>}
      </div>
      <div className="flex gap-2">
        <button type="submit" className="act act-danger" disabled={busy || !ready}>
          {busy ? "Resetting…" : "Reset password and sign out"}
        </button>
        <button type="button" className="act" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
