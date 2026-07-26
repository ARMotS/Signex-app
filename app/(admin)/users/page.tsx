"use client";

import { useState, useEffect } from "react";
import PasswordInput from "@/components/PasswordInput";

/**
 * Each row is an ADMIN account. Because every ADMIN owns its own isolated
 * workspace, the row also carries that workspace's label and row counts — this
 * console is the only place the scopes are visible side by side.
 */
interface Scope {
  tenantId: string;
  slug: string | null;
  companyName: string | null;
  isRoot: boolean;
  counts: { drivers: number; contacts: number; tripSheets: number };
}

interface User {
  id: string;
  name: string | null;
  email: string;
  role: string;
  active: boolean;
  isSelf: boolean;
  createdAt: string;
  scope: Scope;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState("");

  // Deactivate / reactivate
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Delete needing explicit confirmation because the workspace is not empty
  const [deleteCounts, setDeleteCounts] = useState<Scope["counts"] | null>(null);

  // Edit modal state
  const [editUser, setEditUser] = useState<User | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editRole, setEditRole] = useState("ADMIN");
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchUsers = async () => {
    try {
      const res = await fetch("/api/admin/users");
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Inlined rather than calling fetchUsers() so every setState lands in the
    // promise chain, never synchronously inside the effect.
    fetch("/api/admin/users")
      .then((r) => (r.ok ? r.json() : { users: [] }))
      .then((d) => setUsers(d.users || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          companyName: companyName || undefined,
          email,
          password,
          role: "ADMIN",
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setSuccess(
          `Account created for ${data.user.email} in its own isolated workspace`
        );
        setName("");
        setCompanyName("");
        setEmail("");
        setPassword("");
        setShowForm(false);
        fetchUsers();
      } else {
        setError(data.error || "Failed to create account");
      }
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (user: User) => {
    setError("");
    setSuccess("");
    setEditUser(user);
    setEditName(user.name || "");
    setEditEmail(user.email);
    setEditPassword("");
    setEditRole(user.role);
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editUser) return;
    setError("");
    setSuccess("");
    setSavingEdit(true);

    try {
      const res = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editUser.id,
          name: editName,
          email: editEmail,
          password: editPassword || undefined,
          role: editRole,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setSuccess(`Updated ${data.user.email}`);
        setEditUser(null);
        fetchUsers();
      } else {
        setError(data.error || "Failed to update account");
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingEdit(false);
    }
  };

  /**
   * Deleting an ADMIN whose workspace still holds data answers 409 with the row
   * counts. We surface those and require a second, explicit confirmation rather
   * than silently destroying another operator's records.
   */
  const handleDelete = async (confirmPurge = false) => {
    if (!deleteTarget) return;
    setError("");
    setSuccess("");
    setDeleting(true);

    try {
      const res = await fetch("/api/admin/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: deleteTarget.id,
          ...(confirmPurge ? { deleteScopeData: true } : {}),
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setSuccess(`Deleted ${deleteTarget.email}`);
        setDeleteTarget(null);
        setDeleteCounts(null);
        fetchUsers();
      } else if (res.status === 409 && data.requiresConfirmation) {
        setDeleteCounts(data.counts);
      } else {
        setError(data.error || "Failed to delete account");
      }
    } catch {
      setError("Network error");
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleActive = async (user: User) => {
    setError("");
    setSuccess("");
    setTogglingId(user.id);

    try {
      const res = await fetch("/api/admin/users", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: user.id, active: !user.active }),
      });
      const data = await res.json();

      if (res.ok) {
        setSuccess(
          `${user.email} ${data.active ? "reactivated" : "deactivated"}${
            data.active ? "" : " — their drivers can still sign in"
          }`
        );
        fetchUsers();
      } else {
        setError(data.error || "Failed to update account");
      }
    } catch {
      setError("Network error");
    } finally {
      setTogglingId(null);
    }
  };

  const isSelf = (user: User) => user.isSelf;

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-mono text-lg font-medium text-ink-black">Users</h1>
          <p className="text-sm text-ink-muted font-mono mt-1">
            Every admin owns an isolated workspace. They cannot see each other&apos;s
            drivers, contacts, trip sheets or OneDrive.
          </p>
        </div>
        <button
          onClick={() => { setShowForm(!showForm); setError(""); setSuccess(""); }}
          className="px-4 py-2 bg-ink-green text-white text-sm font-mono rounded hover:bg-ink-green/90 transition-colors"
        >
          {showForm ? "Cancel" : "+ New Admin"}
        </button>
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

      {showForm && (
        <form onSubmit={handleCreate} className="bg-ink-card border border-ink-border rounded p-5 mb-6 space-y-4">
          <div>
            <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
              placeholder="Dispatcher name"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
              Company name
            </label>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
              placeholder="Shown to their drivers at sign-in"
            />
            <p className="text-[11px] text-ink-muted mt-1.5">
              This is the only detail drivers see before logging in. Defaults to the
              admin&apos;s name if left blank.
            </p>
          </div>
          <div>
            <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
              placeholder="user@company.com"
            />
          </div>
          <div>
            <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
              Password
            </label>
            <PasswordInput
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
              placeholder="Min 6 characters"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full px-4 py-2.5 bg-ink-green text-white text-sm font-mono rounded hover:bg-ink-green/90 disabled:opacity-50 transition-colors"
          >
            {submitting ? "Creating..." : "Create Admin Account"}
          </button>
        </form>
      )}

      {loading ? (
        <div className="text-sm font-mono text-ink-muted py-8 text-center">Loading...</div>
      ) : users.length === 0 ? (
        <div className="text-sm font-mono text-ink-muted py-8 text-center">No users found</div>
      ) : (
        <div className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="border-b border-ink-border bg-ink-surface">
                <th className="text-left px-4 py-3 text-xs text-ink-muted uppercase tracking-wide">Name</th>
                <th className="text-left px-4 py-3 text-xs text-ink-muted uppercase tracking-wide">Email</th>
                <th className="text-left px-4 py-3 text-xs text-ink-muted uppercase tracking-wide">Role</th>
                <th className="text-left px-4 py-3 text-xs text-ink-muted uppercase tracking-wide">Workspace</th>
                <th className="text-left px-4 py-3 text-xs text-ink-muted uppercase tracking-wide">Status</th>
                <th className="text-right px-4 py-3 text-xs text-ink-muted uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className={`border-b border-ink-border last:border-0 hover:bg-ink-surface/50 ${user.active ? "" : "opacity-60"}`}>
                  <td className="px-4 py-3 text-ink-black">
                    {user.name || "—"}
                    {isSelf(user) && (
                      <span className="ml-2 text-[10px] text-ink-muted uppercase tracking-wide">(you)</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-muted">{user.email}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${
                      user.role === "SUPER_ADMIN"
                        ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                        : "bg-ink-green-dim text-ink-green border border-ink-green/20"
                    }`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-ink-black text-xs">
                      {user.scope.isRoot ? "Root workspace" : user.scope.companyName || "—"}
                    </div>
                    <div className="text-[11px] text-ink-muted">
                      {user.scope.counts.drivers}d · {user.scope.counts.contacts}c ·{" "}
                      {user.scope.counts.tripSheets}ts
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${
                      user.active
                        ? "bg-ink-green-dim text-ink-green border border-ink-green/20"
                        : "bg-ink-amber-dim text-ink-amber border border-ink-amber/20"
                    }`}>
                      {user.active ? "Active" : "Deactivated"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        onClick={() => openEdit(user)}
                        className="px-2.5 py-1 text-xs font-mono text-ink-muted hover:text-ink-black border border-ink-border rounded hover:border-ink-muted-light transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleToggleActive(user)}
                        disabled={isSelf(user) || togglingId === user.id}
                        title={
                          isSelf(user)
                            ? "You cannot deactivate your own account"
                            : user.active
                              ? "Block sign-in. Their drivers keep working."
                              : "Allow sign-in again"
                        }
                        className="px-2.5 py-1 text-xs font-mono text-ink-muted hover:text-ink-black border border-ink-border rounded hover:border-ink-muted-light disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        {togglingId === user.id
                          ? "…"
                          : user.active
                            ? "Deactivate"
                            : "Reactivate"}
                      </button>
                      <button
                        onClick={() => { setError(""); setSuccess(""); setDeleteCounts(null); setDeleteTarget(user); }}
                        disabled={isSelf(user)}
                        title={isSelf(user) ? "You cannot delete your own account" : undefined}
                        className="px-2.5 py-1 text-xs font-mono text-red-400 border border-red-500/20 rounded hover:bg-red-500/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Edit Modal ─────────────────────────────────────────────── */}
      {editUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setEditUser(null)}>
          <div className="bg-ink-card border border-ink-border rounded-lg shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <form onSubmit={handleEdit} className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-mono text-sm font-medium text-ink-black">Edit User</h3>
                <button type="button" onClick={() => setEditUser(null)} className="text-ink-muted hover:text-ink-black">✕</button>
              </div>
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">Name</label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">Email</label>
                <input
                  type="email"
                  value={editEmail}
                  onChange={(e) => setEditEmail(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
                  New Password <span className="text-ink-muted-light normal-case">(leave blank to keep current)</span>
                </label>
                <PasswordInput
                  value={editPassword}
                  onChange={(e) => setEditPassword(e.target.value)}
                  minLength={6}
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                  placeholder="Min 6 characters"
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">Role</label>
                <select
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value)}
                  disabled={isSelf(editUser)}
                  title={isSelf(editUser) ? "You cannot change your own role" : undefined}
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors disabled:opacity-50"
                >
                  <option value="ADMIN">ADMIN</option>
                  <option value="SUPER_ADMIN">SUPER_ADMIN</option>
                </select>
              </div>
              <div className="flex justify-end gap-3 pt-1">
                <button type="button" onClick={() => setEditUser(null)}
                  className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={savingEdit}
                  className="px-4 py-2 text-sm font-mono text-white bg-ink-green rounded hover:bg-ink-green/90 disabled:opacity-50 transition-colors">
                  {savingEdit ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation ────────────────────────────────────── */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setDeleteTarget(null)}>
          <div className="bg-ink-card border border-ink-border rounded-lg shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="p-5">
              {deleteCounts ? (
                <>
                  {/* Second stage: the workspace is not empty, so deleting the
                      admin would destroy their operational records too. */}
                  <h3 className="font-mono text-sm font-medium text-ink-black mb-2">
                    Delete their whole workspace?
                  </h3>
                  <p className="text-sm text-ink-muted mb-3">
                    <span className="font-mono text-ink-black">{deleteTarget.email}</span>{" "}
                    still has data. Deleting the account also deletes:
                  </p>
                  <ul className="text-sm font-mono text-ink-black bg-ink-surface border border-ink-border rounded p-3 mb-3 space-y-1">
                    <li>{deleteCounts.drivers} driver{deleteCounts.drivers === 1 ? "" : "s"}</li>
                    <li>{deleteCounts.contacts} contact{deleteCounts.contacts === 1 ? "" : "s"}</li>
                    <li>{deleteCounts.tripSheets} trip sheet{deleteCounts.tripSheets === 1 ? "" : "s"} and their signatures</li>
                  </ul>
                  <p className="text-sm text-ink-muted mb-4">
                    This cannot be undone.{" "}
                    <span className="text-ink-black">
                      Deactivating them instead is reversible and keeps everything.
                    </span>
                  </p>
                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => { setDeleteTarget(null); setDeleteCounts(null); }}
                      className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => { const t = deleteTarget; setDeleteTarget(null); setDeleteCounts(null); if (t) handleToggleActive(t); }}
                      className="px-4 py-2 text-sm font-mono text-ink-black border border-ink-border rounded hover:bg-ink-surface transition-colors"
                    >
                      Deactivate instead
                    </button>
                    <button
                      onClick={() => handleDelete(true)}
                      disabled={deleting}
                      className="px-4 py-2 text-sm font-mono text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50 transition-colors"
                    >
                      {deleting ? "Deleting…" : "Delete everything"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h3 className="font-mono text-sm font-medium text-ink-black mb-2">Delete user?</h3>
                  <p className="text-sm text-ink-muted mb-4">
                    <span className="font-mono text-ink-black">{deleteTarget.email}</span> will be permanently removed and can no longer sign in. This cannot be undone.
                  </p>
                  <div className="flex justify-end gap-3">
                    <button onClick={() => setDeleteTarget(null)}
                      className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black transition-colors">
                      Cancel
                    </button>
                    <button onClick={() => handleDelete(false)} disabled={deleting}
                      className="px-4 py-2 text-sm font-mono text-white bg-red-500 rounded hover:bg-red-600 disabled:opacity-50 transition-colors">
                      {deleting ? "Deleting…" : "Delete Permanently"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
