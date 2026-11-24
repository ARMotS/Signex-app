"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Pager from "@/components/ui/Pager";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import {
  VEHICLE_REGISTRATION_MAX,
  VEHICLE_TEXT_MAX,
  VEHICLE_TYPE_SUGGESTIONS,
  licenceDiscState,
  readVehicleInput,
  vehicleRegistrationKey,
} from "@/lib/vehicle-registration";

/** As GET /api/vehicles answers it (VehicleRow in lib/vehicles.ts). */
interface Vehicle {
  id: string;
  registration: string;
  make: string | null;
  model: string | null;
  type: string | null;
  isActive: boolean;
  licenceDiscExpiry: string | null;
  liveTrips: number;
  used: boolean;
}

interface Draft {
  registration: string;
  type: string;
  make: string;
  model: string;
  licenceDiscExpiry: string;
}

const EMPTY: Draft = { registration: "", type: "", make: "", model: "", licenceDiscExpiry: "" };

const INPUT_CLASS =
  "w-full px-3 py-2.5 bg-ink-surface border border-ink-border rounded text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors";
const LABEL_CLASS = "block text-xs font-medium text-ink-muted uppercase tracking-wide mb-1.5";

/** The viewer's own today, YYYY-MM-DD — a licence disc expires on the viewer's calendar. */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function describe(v: Vehicle): string {
  return [v.type, [v.make, v.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
}

function DiscCell({ expiry, today }: { expiry: string | null; today: string }) {
  const state = licenceDiscState(expiry, today);
  if (state === "none" || !expiry) return <span className="text-xs text-ink-muted-light">—</span>;
  return (
    <span className="flex items-center gap-2 flex-wrap">
      <span className="text-sm text-ink-black">{formatDay(expiry)}</span>
      {state === "expired" && <span className="status tone-red">Expired</span>}
      {state === "expiring" && <span className="status tone-amber">Expires soon</span>}
    </span>
  );
}

/**
 * The fields of the add and edit forms. The hint under Registration says what
 * a trip sheet's REGNO is matched on, so a dispatcher can see why "CA 123 456"
 * and "CA123-456" are the same vehicle.
 */
function VehicleFields({
  idPrefix,
  draft,
  onChange,
}: {
  idPrefix: string;
  draft: Draft;
  onChange: (next: Draft) => void;
}) {
  const set = (field: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...draft, [field]: e.target.value });
  const key = vehicleRegistrationKey(draft.registration);
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-registration`} className={LABEL_CLASS}>
          Registration *
        </label>
        <input
          id={`${idPrefix}-registration`}
          type="text"
          value={draft.registration}
          onChange={set("registration")}
          required
          maxLength={VEHICLE_REGISTRATION_MAX}
          autoComplete="off"
          placeholder="CA 123-456"
          className={`${INPUT_CLASS} font-mono uppercase`}
        />
        <p className="text-xs text-ink-muted mt-1.5">
          {key
            ? `Trip sheets with REGNO ${key} are linked to this vehicle. Spaces and dashes are ignored.`
            : "Trip sheets' REGNO is matched on this. Spaces and dashes are ignored."}
        </p>
      </div>
      <div>
        <label htmlFor={`${idPrefix}-type`} className={LABEL_CLASS}>
          Type
        </label>
        <input
          id={`${idPrefix}-type`}
          type="text"
          list="vehicle-type-suggestions"
          value={draft.type}
          onChange={set("type")}
          maxLength={VEHICLE_TEXT_MAX}
          autoComplete="off"
          placeholder="Bakkie, truck, van…"
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-make`} className={LABEL_CLASS}>
          Make
        </label>
        <input
          id={`${idPrefix}-make`}
          type="text"
          value={draft.make}
          onChange={set("make")}
          maxLength={VEHICLE_TEXT_MAX}
          autoComplete="off"
          placeholder="Toyota"
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-model`} className={LABEL_CLASS}>
          Model
        </label>
        <input
          id={`${idPrefix}-model`}
          type="text"
          value={draft.model}
          onChange={set("model")}
          maxLength={VEHICLE_TEXT_MAX}
          autoComplete="off"
          placeholder="Hilux"
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-disc`} className={LABEL_CLASS}>
          Licence disc expiry
        </label>
        <input
          id={`${idPrefix}-disc`}
          type="date"
          value={draft.licenceDiscExpiry}
          onChange={set("licenceDiscExpiry")}
          className={INPUT_CLASS}
        />
      </div>
    </>
  );
}

const toDraft = (v: Vehicle): Draft => ({
  registration: v.registration,
  type: v.type ?? "",
  make: v.make ?? "",
  model: v.model ?? "",
  licenceDiscExpiry: v.licenceDiscExpiry ?? "",
});

/**
 * Drivers → Vehicles: the branch's fleet. A vehicle is never a default for a
 * driver; a trip names its own. A vehicle that has been on a trip can only be
 * deactivated, so the trip's record keeps it.
 */
export default function VehiclesPanel({ tabBar }: { tabBar: ReactNode }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [notice, setNotice] = useState("");
  const [rowError, setRowError] = useState("");

  const [showAdd, setShowAdd] = useState(false);
  const [addDraft, setAddDraft] = useState<Draft>(EMPTY);
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(EMPTY);
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);

  const [deleting, setDeleting] = useState<Vehicle | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [today] = useState(localToday);

  const fetchVehicles = useCallback(async () => {
    try {
      const res = await fetch("/api/vehicles");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load vehicles");
      setVehicles(data.vehicles || []);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load vehicles");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVehicles();
  }, [fetchVehicles]);

  const addCheck = readVehicleInput({ ...addDraft });
  const editCheck = readVehicleInput({ ...editDraft });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addCheck.ok) return setAddError(addCheck.error);
    setAddError("");
    setAdding(true);
    try {
      const res = await fetch("/api/vehicles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addDraft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAddError(data.error || "Could not add the vehicle");
        return;
      }
      setNotice(`${data.vehicle.registration} added.`);
      setAddDraft(EMPTY);
      setShowAdd(false);
      fetchVehicles();
    } catch {
      setAddError("Network error");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (v: Vehicle) => {
    setEditingId(v.id);
    setEditDraft(toDraft(v));
    setEditError("");
    setNotice("");
    setRowError("");
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId) return;
    if (!editCheck.ok) return setEditError(editCheck.error);
    setEditError("");
    setSaving(true);
    try {
      const res = await fetch(`/api/vehicles/${encodeURIComponent(editingId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editDraft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditError(data.error || "Could not save the vehicle");
        return;
      }
      setEditingId(null);
      fetchVehicles();
    } catch {
      setEditError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (v: Vehicle) => {
    setRowError("");
    setNotice("");
    try {
      const res = await fetch(`/api/vehicles/${encodeURIComponent(v.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !v.isActive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRowError(`${v.registration}: ${data.error || "Could not change the vehicle"}`);
      }
    } catch {
      setRowError(`${v.registration}: network error`);
    }
    fetchVehicles();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/vehicles/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(data.error || "Could not delete the vehicle");
        // It was put on a trip meanwhile: the list should now offer Deactivate.
        if (data.code === "IN_USE" || data.code === "NOT_FOUND") fetchVehicles();
        return;
      }
      setNotice(`${deleting.registration} deleted.`);
      setDeleting(null);
      fetchVehicles();
    } catch {
      setDeleteError("Network error");
    } finally {
      setDeleteBusy(false);
    }
  };

  const active = vehicles.filter((v) => v.isActive);
  const lastPage = Math.max(1, Math.ceil(vehicles.length / pageSize));
  const shownPage = Math.min(page, lastPage);
  const shown = vehicles.slice((shownPage - 1) * pageSize, shownPage * pageSize);

  return (
    <>
      <div className="flex items-start justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-black tracking-tight">Drivers</h1>
          <p className="text-sm text-ink-muted mt-1">
            {loading ? "Loading…" : `${active.length} active vehicle${active.length !== 1 ? "s" : ""}`}
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
          Add Vehicle
        </button>
      </div>

      {tabBar}

      <datalist id="vehicle-type-suggestions">
        {VEHICLE_TYPE_SUGGESTIONS.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      {(rowError || loadError) && (
        <div role="alert" className="flex items-start justify-between gap-3 px-4 py-3 mb-6 bg-ink-red-dim rounded border border-ink-red/20 animate-fade-in">
          <span className="text-sm text-ink-black">{rowError || loadError}</span>
          {rowError && (
            <button onClick={() => setRowError("")} className="text-xs text-ink-muted hover:text-ink-black shrink-0" aria-label="Dismiss">
              ✕
            </button>
          )}
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start justify-between gap-3 px-4 py-3 mb-6 bg-ink-green-dim rounded border border-ink-green/20 animate-fade-in">
          <span className="text-sm text-ink-black">{notice}</span>
          <button onClick={() => setNotice("")} className="text-xs text-ink-muted hover:text-ink-black shrink-0" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {/* ─── Add Vehicle Form ─────────────────────────────────────────── */}
      {showAdd && (
        <div className="bg-ink-card border border-ink-green/30 rounded p-6 mb-6 animate-fade-in">
          <h3 className="text-sm font-semibold text-ink-black mb-4">New Vehicle</h3>
          {addError && (
            <div role="alert" className="flex items-center gap-2 px-3 py-2 mb-4 bg-ink-red-dim rounded border border-ink-red/20">
              <span className="text-xs text-ink-red">{addError}</span>
            </div>
          )}
          <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <VehicleFields idPrefix="new-vehicle" draft={addDraft} onChange={setAddDraft} />
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
                disabled={!addCheck.ok || adding}
                className="px-6 py-2.5 bg-ink-green text-white text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all disabled:opacity-50"
              >
                {adding ? "Adding…" : "Add vehicle"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ─── Loading ──────────────────────────────────────────────────── */}
      {loading && (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-ink-muted">Loading vehicles…</p>
        </div>
      )}

      {/* ─── Empty State ──────────────────────────────────────────────── */}
      {!loading && !loadError && vehicles.length === 0 && (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <p className="text-sm font-medium text-ink-black mb-2">No vehicles yet</p>
          <p className="text-xs text-ink-muted max-w-sm mx-auto mb-4">
            Add your fleet so every trip can name the vehicle that drove it. Trip sheets whose REGNO
            matches a registration here are linked to that vehicle automatically.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="px-5 py-2.5 bg-ink-green text-white text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all"
          >
            Add First Vehicle
          </button>
        </div>
      )}

      {/* ─── Vehicle Table ────────────────────────────────────────────── */}
      {!loading && vehicles.length > 0 && (
        <div className="bg-ink-card border border-ink-border rounded">
          <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 border-b border-ink-border text-xs font-medium text-ink-muted uppercase tracking-wide">
            <div className="col-span-2">Registration</div>
            <div className="col-span-3">Vehicle</div>
            <div className="col-span-3">Licence disc</div>
            <div className="col-span-1">Status</div>
            <div className="col-span-3 text-right">Actions</div>
          </div>
          <div className="divide-y divide-ink-border stagger-children">
            {shown.map((v) => (
              <div key={v.id}>
                {editingId === v.id ? (
                  <form onSubmit={handleEdit} className="px-5 py-4 bg-ink-surface/50 animate-fade-in">
                    <p className="text-sm font-semibold text-ink-black mb-3">Edit {v.registration}</p>
                    {editError && (
                      <div role="alert" className="flex items-center gap-2 px-3 py-2 mb-3 bg-ink-red-dim rounded border border-ink-red/20">
                        <span className="text-xs text-ink-red">{editError}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <VehicleFields idPrefix={`edit-${v.id}`} draft={editDraft} onChange={setEditDraft} />
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
                        disabled={!editCheck.ok || saving}
                        className="px-5 py-2 bg-ink-green text-white text-xs font-medium rounded hover:bg-ink-green-hover transition-all disabled:opacity-50"
                      >
                        {saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div
                    className={`grid grid-cols-1 md:grid-cols-12 gap-2 md:gap-4 items-center px-5 py-4 transition-colors ${
                      v.isActive ? "hover:bg-ink-surface/50" : "opacity-50 bg-ink-surface/30"
                    }`}
                  >
                    <div className="md:col-span-2 min-w-0">
                      <span className="font-mono text-sm font-medium text-ink-black">{v.registration}</span>
                      {v.liveTrips > 0 && (
                        <span className="block text-xs text-ink-muted mt-0.5">
                          On {v.liveTrips} live trip{v.liveTrips !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div className="md:col-span-3 min-w-0">
                      <span className="text-sm text-ink-black truncate block">
                        {describe(v) || <span className="text-ink-muted-light">—</span>}
                      </span>
                    </div>
                    <div className="md:col-span-3">
                      <DiscCell expiry={v.licenceDiscExpiry} today={today} />
                    </div>
                    <div className="md:col-span-1">
                      <span className={v.isActive ? "status tone-green" : "status tone-idle"}>
                        {v.isActive ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <div className="md:col-span-3 flex items-center md:justify-end gap-1.5 flex-wrap">
                      <button onClick={() => startEdit(v)} className="act">
                        Edit
                      </button>
                      <button onClick={() => toggleActive(v)} className={v.isActive ? "act act-amber" : "act act-green"}>
                        {v.isActive ? "Deactivate" : "Activate"}
                      </button>
                      {!v.used && (
                        <button
                          onClick={() => {
                            setDeleting(v);
                            setDeleteError("");
                          }}
                          className="act act-danger"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <Pager
            page={shownPage}
            pageSize={pageSize}
            total={vehicles.length}
            onPage={setPage}
            onPageSize={(n) => {
              setPageSize(n);
              setPage(1);
            }}
          />
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.registration}?`}
          confirmLabel="Delete vehicle"
          busyLabel="Deleting…"
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        >
          <p>It has never been on a trip, so nothing refers to it. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
