"use client";

import { useState, useEffect } from "react";

interface User {
  id: string;
  name: string | null;
  email: string;
  role: string;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState("");

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
    fetchUsers();
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
        body: JSON.stringify({ name, email, password, role: "ADMIN" }),
      });
      const data = await res.json();

      if (res.ok) {
        setSuccess(`Account created for ${data.user.email}`);
        setName("");
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

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-mono text-lg font-medium text-ink-black">Users</h1>
          <p className="text-sm text-ink-muted font-mono mt-1">
            Manage admin accounts for this tenant
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
            <input
              type="password"
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
                <th className="text-left px-4 py-3 text-xs text-ink-muted uppercase tracking-wide">Created</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b border-ink-border last:border-0 hover:bg-ink-surface/50">
                  <td className="px-4 py-3 text-ink-black">{user.name || "—"}</td>
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
                  <td className="px-4 py-3 text-ink-muted">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}