"use client";

import { useState, useEffect, useCallback } from "react";

interface Driver {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
}

export default function DriversPage() {
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Add form
  const [newName, setNewName] = useState("");
  const [newPin, setNewPin] = useState("");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);

  // Edit form
  const [editName, setEditName] = useState("");
  const [editPin, setEditPin] = useState("");
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

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError("");
    setAdding(true);

    try {
      const res = await fetch("/api/drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          pin: newPin,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setNewName("");
        setNewPin("");
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
    setEditPin("");
    setEditError("");
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    setEditError("");
    setSaving(true);

    try {
      const updates: Record<string, string> = { id: editingId };
      if (editName) updates.name = editName;
      if (editPin) updates.pin = editPin;

      const res = await fetch("/api/drivers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json();

      if (res.ok) {
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

  return (
    <div className="animate-fade-in">
      <div className="flex items-start justify-between mb-8 gap-4">
        <div>
          <h1 className="font-mono text-2xl font-medium text-ink-black tracking-tight">
            Drivers
          </h1>
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
          }}
          className="flex items-center gap-2 px-4 py-2.5 bg-ink-green text-white font-mono text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Driver
        </button>
      </div>

      {/* ─── Add Driver Form ──────────────────────────────────────────── */}
      {showAdd && (
        <div className="bg-ink-card border border-ink-green/30 rounded p-6 mb-6 animate-fade-in">
          <h3 className="font-mono text-sm font-medium text-ink-black mb-4">
            New Driver Account
          </h3>
          {addError && (
            <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-ink-red-dim rounded border border-ink-red/20">
              <span className="text-xs font-mono text-ink-red">{addError}</span>
            </div>
          )}
          <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
                Full Name *
              </label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                placeholder="Sipho Dlamini"
                className="w-full px-3 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
                4-Digit PIN *
              </label>
              <input
                type="text"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                required
                maxLength={4}
                placeholder="1234"
                className="w-full px-3 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors tracking-[0.3em]"
              />
            </div>
            <div className="flex items-end gap-2">
              <button
                type="submit"
                disabled={adding || newPin.length !== 4 || !newName.trim()}
                className="flex-1 px-4 py-2.5 bg-ink-green text-white font-mono text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all disabled:opacity-50"
              >
                {adding ? "Adding…" : "Add"}
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="px-4 py-2.5 text-ink-muted font-mono text-sm hover:text-ink-black transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ─── Loading ──────────────────────────────────────────────────── */}
      {loading && (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-ink-muted">Loading drivers…</p>
        </div>
      )}

      {/* ─── Empty State ──────────────────────────────────────────────── */}
      {!loading && drivers.length === 0 && (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <div className="text-4xl mb-4">👤</div>
          <p className="font-mono text-sm font-medium text-ink-black mb-2">
            No drivers yet
          </p>
          <p className="text-xs text-ink-muted max-w-sm mx-auto mb-4">
            Add driver accounts so they can log in to the driver app with their name and PIN.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="px-5 py-2.5 bg-ink-green text-white font-mono text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all"
          >
            Add First Driver
          </button>
        </div>
      )}

      {/* ─── Driver Table ─────────────────────────────────────────────── */}
      {!loading && drivers.length > 0 && (
        <div className="bg-ink-card border border-ink-border rounded">
          <div className="hidden sm:grid grid-cols-12 gap-4 px-5 py-3 border-b border-ink-border text-xs font-mono text-ink-muted uppercase tracking-wide">
            <div className="col-span-5">Driver</div>
            <div className="col-span-3">Status</div>
            <div className="col-span-4 text-right">Actions</div>
          </div>
          <div className="divide-y divide-ink-border stagger-children">
            {[...activeDrivers, ...inactiveDrivers].map((d) => (
              <div key={d.id}>
                {editingId === d.id ? (
                  /* Edit mode */
                  <form
                    onSubmit={handleEdit}
                    className="px-5 py-4 bg-ink-surface/50 animate-fade-in"
                  >
                    {editError && (
                      <div className="flex items-center gap-2 px-3 py-2 mb-3 bg-ink-red-dim rounded border border-ink-red/20">
                        <span className="text-xs font-mono text-ink-red">{editError}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="Name"
                        className="px-3 py-2 bg-ink-card border border-ink-border rounded font-mono text-sm focus:outline-none focus:border-ink-green transition-colors"
                      />
                      <input
                        type="text"
                        value={editPin}
                        onChange={(e) => setEditPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                        placeholder="New PIN (leave blank to keep)"
                        maxLength={4}
                        className="px-3 py-2 bg-ink-card border border-ink-border rounded font-mono text-sm focus:outline-none focus:border-ink-green transition-colors tracking-[0.3em]"
                      />
                      <div className="flex gap-2">
                        <button
                          type="submit"
                          disabled={saving}
                          className="flex-1 px-3 py-2 bg-ink-green text-white font-mono text-xs font-medium rounded hover:bg-ink-green-hover transition-all disabled:opacity-50"
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingId(null)}
                          className="px-3 py-2 text-ink-muted font-mono text-xs hover:text-ink-black transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  </form>
                ) : (
                  /* Display mode */
                  <div
                    className={`grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-4 items-center px-5 py-4 transition-colors ${
                      d.active
                        ? "hover:bg-ink-surface/50"
                        : "opacity-50 bg-ink-surface/30"
                    }`}
                  >
                    <div className="sm:col-span-5 flex items-center gap-3">
                      <div className="w-9 h-9 rounded bg-ink-surface flex items-center justify-center shrink-0">
                        <span className="text-xs font-mono font-medium text-ink-muted">
                          {d.name
                            .split(" ")
                            .map((n) => n[0])
                            .join("")}
                        </span>
                      </div>
                      <span className="text-sm font-medium text-ink-black">
                        {d.name}
                      </span>
                    </div>
                    <div className="sm:col-span-3">
                      <span
                        className={
                          d.active ? "badge-signed" : "badge-pending"
                        }
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            d.active ? "bg-ink-green" : "bg-ink-red"
                          }`}
                        />
                        {d.active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <div className="sm:col-span-4 flex items-center justify-end gap-2">
                      <button
                        onClick={() => startEdit(d)}
                        className="px-3 py-1.5 text-xs font-mono text-ink-muted hover:text-ink-black hover:bg-ink-surface rounded transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => toggleActive(d)}
                        className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${
                          d.active
                            ? "text-ink-amber hover:bg-ink-amber-dim"
                            : "text-ink-green hover:bg-ink-green-dim"
                        }`}
                      >
                        {d.active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => handleDelete(d)}
                        className="px-3 py-1.5 text-xs font-mono text-ink-red hover:bg-ink-red-dim rounded transition-colors"
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
