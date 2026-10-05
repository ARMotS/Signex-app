"use client";

import { useState, useEffect, useCallback } from "react";
import PasswordInput from "@/components/PasswordInput";
import UsernameField, { type UsernameStatus } from "@/components/UsernameField";
import { validatePassword, PASSWORD_HINT } from "@/lib/credentials";

interface Driver {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  username: string | null;
  /** False for drivers created before usernames existed — they need a login set. */
  canSignIn: boolean;
}

const INPUT_CLASS =
  "w-full px-3 py-2.5 bg-ink-surface border border-ink-border rounded text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors";
const LABEL_CLASS = "block text-xs font-medium text-ink-muted uppercase tracking-wide mb-1.5";

/** A username the form may submit: new and free, or the account's own. */
const usernameUsable = (s: UsernameStatus) => s === "available" || s === "unchanged";

export default function DriversPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  // Add form
  const [newName, setNewName] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newUsernameStatus, setNewUsernameStatus] = useState<UsernameStatus>("empty");
  const [newPassword, setNewPassword] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);

  // Edit form — also how a login is set for a driver who has none, and how a
  // password is reset.
  const [editName, setEditName] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editUsernameStatus, setEditUsernameStatus] = useState<UsernameStatus>("empty");
  const [editPassword, setEditPassword] = useState("");
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchDrivers = useCallback(async () => {
    try {
      const res = await fetch("/api/drivers");
      const data = await res.json();
      setDrivers(data.drivers || []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDrivers();
  }, [fetchDrivers]);

  const newPasswordError = newPassword ? validatePassword(newPassword) : null;
  const canAdd =
    !!newName.trim() &&
    usernameUsable(newUsernameStatus) &&
    !!newPassword &&
    !newPasswordError &&
    !adding;

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError("");
    setAdding(true);

    try {
      const res = await fetch("/api/drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, username: newUsername, password: newPassword }),
      });
      const data = await res.json();

      if (res.ok) {
        setNotice(`${data.driver.name} can now log in as “${data.driver.username}”.`);
        setNewName("");
        setNewUsername("");
        setNewPassword("");
        setShowAdd(false);
        fetchDrivers();
      } else {
        setAddError(data.error || "Failed to add driver");
      }
    } catch {
      setAddError("Network error");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (driver: Driver) => {
    setEditingId(driver.id);
    setEditName(driver.name);
    setEditUsername(driver.username ?? "");
    setEditPassword("");
    setEditError("");
    setNotice("");
  };

  const editing = drivers.find((d) => d.id === editingId) ?? null;
  // A driver with no login needs both fields; otherwise the password is optional.
  const editNeedsPassword = !!editing && !editing.canSignIn;
  const editPasswordError = editPassword ? validatePassword(editPassword) : null;
  // A driver with no login can still be renamed without setting one.
  const nameOnlyEdit =
    !!editing && !editing.username && editUsernameStatus === "empty" && !editPassword;
  const canSave =
    !!editName.trim() &&
    !editPasswordError &&
    (nameOnlyEdit ||
      (usernameUsable(editUsernameStatus) && (!editNeedsPassword || !!editPassword))) &&
    !saving;

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setEditError("");
    setSaving(true);

    try {
      const updates: Record<string, string> = { id: editing.id };
      if (editName.trim() !== editing.name) updates.name = editName;
      if (editUsername && editUsername !== editing.username) updates.username = editUsername;
      if (editPassword) updates.password = editPassword;

      const res = await fetch("/api/drivers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json();

      if (res.ok) {
        if (editPassword) {
          setNotice(
            editing.canSignIn
              ? `Password reset for ${editing.name}. They have been signed out — give them the new password.`
              : `${editing.name} can now log in.`
          );
        }
        setEditingId(null);
        fetchDrivers();
      } else {
        setEditError(data.error || "Failed to update driver");
      }
    } catch {
      setEditError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (driver: Driver) => {
    try {
      await fetch("/api/drivers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: driver.id, active: !driver.active }),
      });
      fetchDrivers();
    } catch {
      // ignore
    }
  };

  const handleDelete = async (driver: Driver) => {
    if (!confirm(`Delete driver "${driver.name}"? This cannot be undone.`)) return;

    try {
      await fetch("/api/drivers", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: driver.id }),
      });
      fetchDrivers();
    } catch {
      // ignore
    }
  };

  const activeDrivers = drivers.filter((d) => d.active);
  const inactiveDrivers = drivers.filter((d) => !d.active);
  const withoutLogin = drivers.filter((d) => !d.canSignIn);

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-black tracking-tight">Drivers</h1>
          <p className="text-sm text-ink-muted mt-1">
            {loading
              ? "Loading…"
              : `${activeDrivers.length} active driver${activeDrivers.length !== 1 ? "s" : ""}`}
          </p>
        </div>
        <button
          onClick={() => {
            setShowAdd(!showAdd);
            setAddError("");
            setNotice("");
          }}
          className="flex items-center gap-2 px-4 py-2.5 bg-ink-green text-white text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all shrink-0"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Driver
        </button>
      </div>

      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 px-4 py-3 mb-6 bg-ink-green-dim rounded border border-ink-green/20 animate-fade-in"
        >
          <span className="text-sm text-ink-black">{notice}</span>
          <button
            onClick={() => setNotice("")}
            className="text-xs text-ink-muted hover:text-ink-black shrink-0"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* ─── Drivers who cannot sign in yet ────────────────────────────────
          Everyone now signs in with a username and password at /login. Drivers
          created when sign-in was a name + PIN have neither until an admin sets
          them here. */}
      {!loading && withoutLogin.length > 0 && (
        <div className="bg-ink-amber-dim border border-ink-amber/30 rounded p-4 mb-6">
          <p className="text-sm font-medium text-ink-black">
            {`${withoutLogin.length} driver${withoutLogin.length !== 1 ? "s" : ""} can't log in yet`}
          </p>
          <p className="text-xs text-ink-muted mt-1 mb-3 max-w-xl">
            Drivers now log in with a username and password instead of a PIN. Set a login for
            each driver below, then give it to them.
          </p>
          <div className="flex flex-wrap gap-2">
            {withoutLogin.map((d) => (
              <button
                key={d.id}
                onClick={() => startEdit(d)}
                className="px-3 py-1.5 text-xs font-medium bg-ink-card border border-ink-border rounded hover:border-ink-amber transition-colors"
              >
                Set login · {d.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Add Driver Form ──────────────────────────────────────────── */}
      {showAdd && (
        <div className="bg-ink-card border border-ink-green/30 rounded p-6 mb-6 animate-fade-in">
          <h3 className="text-sm font-semibold text-ink-black mb-4">New Driver Account</h3>
          {addError && (
            <div role="alert" className="flex items-center gap-2 px-3 py-2 mb-4 bg-ink-red-dim rounded border border-ink-red/20">
              <span className="text-xs text-ink-red">{addError}</span>
            </div>
          )}
          <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label htmlFor="new-driver-name" className={LABEL_CLASS}>
                Full name *
              </label>
              <input
                id="new-driver-name"
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                autoComplete="off"
                placeholder="As it appears on trip sheets"
                className={INPUT_CLASS}
              />
              <p className="text-xs text-ink-muted mt-1.5">Trip sheets are matched on this name.</p>
            </div>
            <div>
              <label htmlFor="new-driver-username" className={LABEL_CLASS}>
                Username *
              </label>
              <UsernameField
                id="new-driver-username"
                value={newUsername}
                onChange={setNewUsername}
                onStatusChange={setNewUsernameStatus}
                required
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label htmlFor="new-driver-password" className={LABEL_CLASS}>
                Password *
              </label>
              <PasswordInput
                id="new-driver-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                autoComplete="new-password"
                placeholder="Set a password"
                className={INPUT_CLASS}
              />
              <p className={`text-xs mt-1.5 ${newPasswordError ? "text-ink-red" : "text-ink-muted"}`}>
                {newPasswordError ?? PASSWORD_HINT}
              </p>
            </div>
            <div className="md:col-span-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="px-4 py-2.5 text-ink-muted text-sm hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canAdd}
                className="px-6 py-2.5 bg-ink-green text-white text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all disabled:opacity-50"
              >
                {adding ? "Adding…" : "Add driver"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ─── Loading ──────────────────────────────────────────────────── */}
      {loading && (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-ink-muted">Loading drivers…</p>
        </div>
      )}

      {/* ─── Empty State ──────────────────────────────────────────────── */}
      {!loading && drivers.length === 0 && (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <div className="text-4xl mb-4">👤</div>
          <p className="text-sm font-medium text-ink-black mb-2">No drivers yet</p>
          <p className="text-xs text-ink-muted max-w-sm mx-auto mb-4">
            Add driver accounts so they can log in to the driver app with their own username and
            password.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="px-5 py-2.5 bg-ink-green text-white text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all"
          >
            Add First Driver
          </button>
        </div>
      )}

      {/* ─── Driver Table ─────────────────────────────────────────────── */}
      {!loading && drivers.length > 0 && (
        <div className="bg-ink-card border border-ink-border rounded">
          <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 border-b border-ink-border text-xs font-medium text-ink-muted uppercase tracking-wide">
            <div className="col-span-3">Driver</div>
            <div className="col-span-3">Username</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-4 text-right">Actions</div>
          </div>
          <div className="divide-y divide-ink-border stagger-children">
            {[...activeDrivers, ...inactiveDrivers].map((d) => (
              <div key={d.id}>
                {editingId === d.id ? (
                  /* Edit mode — also sets a login, or resets a password */
                  <form onSubmit={handleEdit} className="px-5 py-4 bg-ink-surface/50 animate-fade-in">
                    <p className="text-sm font-semibold text-ink-black mb-3">
                      {d.canSignIn ? `Edit ${d.name}` : `Set a login for ${d.name}`}
                    </p>
                    {editError && (
                      <div role="alert" className="flex items-center gap-2 px-3 py-2 mb-3 bg-ink-red-dim rounded border border-ink-red/20">
                        <span className="text-xs text-ink-red">{editError}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div>
                        <label htmlFor={`edit-name-${d.id}`} className={LABEL_CLASS}>
                          Full name
                        </label>
                        <input
                          id={`edit-name-${d.id}`}
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          autoComplete="off"
                          className={INPUT_CLASS}
                        />
                      </div>
                      <div>
                        <label htmlFor={`edit-username-${d.id}`} className={LABEL_CLASS}>
                          Username{d.canSignIn ? "" : " *"}
                        </label>
                        <UsernameField
                          id={`edit-username-${d.id}`}
                          value={editUsername}
                          onChange={setEditUsername}
                          currentUsername={d.username}
                          onStatusChange={setEditUsernameStatus}
                          required={!d.canSignIn}
                          className={INPUT_CLASS}
                        />
                      </div>
                      <div>
                        <label htmlFor={`edit-password-${d.id}`} className={LABEL_CLASS}>
                          {d.canSignIn ? "New password" : "Password *"}
                        </label>
                        <PasswordInput
                          id={`edit-password-${d.id}`}
                          value={editPassword}
                          onChange={(e) => setEditPassword(e.target.value)}
                          required={editNeedsPassword}
                          autoComplete="new-password"
                          placeholder={d.canSignIn ? "Leave blank to keep" : "Set a password"}
                          className={INPUT_CLASS}
                        />
                        <p className={`text-xs mt-1.5 ${editPasswordError ? "text-ink-red" : "text-ink-muted"}`}>
                          {editPasswordError ??
                            (d.canSignIn
                              ? "Resetting signs the driver out on every device."
                              : PASSWORD_HINT)}
                        </p>
                      </div>
                    </div>
                    <div className="flex justify-end gap-2 mt-3">
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="px-3 py-2 text-ink-muted text-xs hover:text-ink-black transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!canSave}
                        className="px-5 py-2 bg-ink-green text-white text-xs font-medium rounded hover:bg-ink-green-hover transition-all disabled:opacity-50"
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </form>
                ) : (
                  /* Display mode */
                  <div
                    className={`grid grid-cols-1 md:grid-cols-12 gap-2 md:gap-4 items-center px-5 py-4 transition-colors ${
                      d.active ? "hover:bg-ink-surface/50" : "opacity-50 bg-ink-surface/30"
                    }`}
                  >
                    <div className="md:col-span-3 flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded bg-ink-surface flex items-center justify-center shrink-0">
                        <span className="text-xs font-medium text-ink-muted">
                          {d.name
                            .split(" ")
                            .map((n) => n[0])
                            .join("")
                            .slice(0, 3)}
                        </span>
                      </div>
                      <span className="text-sm font-medium text-ink-black truncate">{d.name}</span>
                    </div>
                    <div className="md:col-span-3 min-w-0">
                      {d.canSignIn ? (
                        <span className="text-sm text-ink-black truncate block">{d.username}</span>
                      ) : (
                        <span className="badge-progress">No login</span>
                      )}
                    </div>
                    <div className="md:col-span-2">
                      <span className={d.active ? "badge-signed" : "badge-pending"}>
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${d.active ? "bg-ink-green" : "bg-ink-red"}`}
                        />
                        {d.active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <div className="md:col-span-4 flex items-center justify-end gap-1 flex-wrap">
                      <button
                        onClick={() => startEdit(d)}
                        className="px-3 py-1.5 text-xs whitespace-nowrap text-ink-muted hover:text-ink-black hover:bg-ink-surface rounded transition-colors"
                      >
                        {d.canSignIn ? "Edit / password" : "Set login"}
                      </button>
                      <button
                        onClick={() => toggleActive(d)}
                        className={`px-3 py-1.5 text-xs rounded transition-colors ${
                          d.active
                            ? "text-ink-amber hover:bg-ink-amber-dim"
                            : "text-ink-green hover:bg-ink-green-dim"
                        }`}
                      >
                        {d.active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => handleDelete(d)}
                        className="px-3 py-1.5 text-xs text-ink-red hover:bg-ink-red-dim rounded transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
