"use client";

import { useCallback, useEffect, useState } from "react";
import Pager from "@/components/ui/Pager";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import {
  COURIER_NAME_MAX,
  COURIER_NOTES_MAX,
  COURIER_TEXT_MAX,
  readCourierCompanyInput,
} from "@/lib/courier-company-input";

/** As GET /api/courier-companies answers it (CourierCompanyRow in lib/courier-companies.ts). */
interface CourierCompany {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  accountNumber: string | null;
  notes: string | null;
  isActive: boolean;
}

interface Draft {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  accountNumber: string;
  notes: string;
}

const EMPTY: Draft = { name: "", contactPerson: "", phone: "", email: "", accountNumber: "", notes: "" };

const toDraft = (c: CourierCompany): Draft => ({
  name: c.name,
  contactPerson: c.contactPerson ?? "",
  phone: c.phone ?? "",
  email: c.email ?? "",
  accountNumber: c.accountNumber ?? "",
  notes: c.notes ?? "",
});

const INPUT_CLASS =
  "w-full px-3 py-2.5 bg-ink-surface border border-ink-border rounded text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors";
const LABEL_CLASS = "block text-xs font-medium text-ink-muted uppercase tracking-wide mb-1.5";

const LINE_FIELDS: { field: keyof Draft; label: string; placeholder: string; type?: string; max: number }[] = [
  { field: "name", label: "Name *", placeholder: "The Courier Guy", max: COURIER_NAME_MAX },
  { field: "contactPerson", label: "Contact person", placeholder: "Thandi Mokoena", max: COURIER_TEXT_MAX },
  { field: "phone", label: "Phone", placeholder: "021 555 0100", type: "tel", max: COURIER_TEXT_MAX },
  { field: "email", label: "Email", placeholder: "ops@courier.co.za", type: "email", max: COURIER_TEXT_MAX },
  { field: "accountNumber", label: "Account number", placeholder: "ACC-10042", max: COURIER_TEXT_MAX },
];

function CourierFields({
  idPrefix,
  draft,
  onChange,
}: {
  idPrefix: string;
  draft: Draft;
  onChange: (next: Draft) => void;
}) {
  return (
    <>
      {LINE_FIELDS.map(({ field, label, placeholder, type, max }) => (
        <div key={field}>
          <label htmlFor={`${idPrefix}-${field}`} className={LABEL_CLASS}>
            {label}
          </label>
          <input
            id={`${idPrefix}-${field}`}
            type={type ?? "text"}
            value={draft[field]}
            onChange={(e) => onChange({ ...draft, [field]: e.target.value })}
            required={field === "name"}
            maxLength={max}
            autoComplete="off"
            placeholder={placeholder}
            className={`${INPUT_CLASS} ${field === "accountNumber" ? "font-mono" : ""}`}
          />
        </div>
      ))}
      <div className="md:col-span-3">
        <label htmlFor={`${idPrefix}-notes`} className={LABEL_CLASS}>
          Notes
        </label>
        <textarea
          id={`${idPrefix}-notes`}
          value={draft.notes}
          onChange={(e) => onChange({ ...draft, notes: e.target.value })}
          maxLength={COURIER_NOTES_MAX}
          rows={2}
          placeholder="Collection cut-off, depot address, anything the office should know"
          className={INPUT_CLASS}
        />
      </div>
    </>
  );
}

/**
 * Contacts → Courier companies: who the branch hands parcels to. Separate from
 * customer contacts on purpose — customer emails find their recipient by
 * company name, and must never find a courier. Signex never emails these.
 */
export default function CourierCompaniesPanel() {
  const [companies, setCompanies] = useState<CourierCompany[]>([]);
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

  const [deleting, setDeleting] = useState<CourierCompany | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const fetchCompanies = useCallback(async () => {
    try {
      const res = await fetch("/api/courier-companies");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not load courier companies");
      setCompanies(data.courierCompanies || []);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load courier companies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  const addCheck = readCourierCompanyInput({ ...addDraft });
  const editCheck = readCourierCompanyInput({ ...editDraft });

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addCheck.ok) return setAddError(addCheck.error);
    setAddError("");
    setAdding(true);
    try {
      const res = await fetch("/api/courier-companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addDraft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAddError(data.error || "Could not add the courier company");
        return;
      }
      setNotice(`${data.courierCompany.name} added.`);
      setAddDraft(EMPTY);
      setShowAdd(false);
      fetchCompanies();
    } catch {
      setAddError("Network error");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (c: CourierCompany) => {
    setEditingId(c.id);
    setEditDraft(toDraft(c));
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
      const res = await fetch(`/api/courier-companies/${encodeURIComponent(editingId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editDraft),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setEditError(data.error || "Could not save the courier company");
        return;
      }
      setEditingId(null);
      fetchCompanies();
    } catch {
      setEditError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (c: CourierCompany) => {
    setRowError("");
    setNotice("");
    try {
      const res = await fetch(`/api/courier-companies/${encodeURIComponent(c.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !c.isActive }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRowError(`${c.name}: ${data.error || "Could not change the courier company"}`);
      }
    } catch {
      setRowError(`${c.name}: network error`);
    }
    fetchCompanies();
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const res = await fetch(`/api/courier-companies/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDeleteError(data.error || "Could not delete the courier company");
        if (data.code === "NOT_FOUND") fetchCompanies();
        return;
      }
      setNotice(`${deleting.name} deleted.`);
      setDeleting(null);
      fetchCompanies();
    } catch {
      setDeleteError("Network error");
    } finally {
      setDeleteBusy(false);
    }
  };

  const active = companies.filter((c) => c.isActive);
  const lastPage = Math.max(1, Math.ceil(companies.length / pageSize));
  const shownPage = Math.min(page, lastPage);
  const shown = companies.slice((shownPage - 1) * pageSize, shownPage * pageSize);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-ink-muted">
          {loading
            ? "Loading…"
            : `${active.length} active courier compan${active.length !== 1 ? "ies" : "y"}. Signex never emails them.`}
        </p>
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
          Add Courier Company
        </button>
      </div>

      {(rowError || loadError) && (
        <div role="alert" className="flex items-start justify-between gap-3 px-4 py-3 bg-ink-red-dim rounded border border-ink-red/20 animate-fade-in">
          <span className="text-sm text-ink-black">{rowError || loadError}</span>
          {rowError && (
            <button onClick={() => setRowError("")} className="text-xs text-ink-muted hover:text-ink-black shrink-0" aria-label="Dismiss">
              ✕
            </button>
          )}
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-start justify-between gap-3 px-4 py-3 bg-ink-green-dim rounded border border-ink-green/20 animate-fade-in">
          <span className="text-sm text-ink-black">{notice}</span>
          <button onClick={() => setNotice("")} className="text-xs text-ink-muted hover:text-ink-black shrink-0" aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {showAdd && (
        <div className="bg-ink-card border border-ink-green/30 rounded p-6 animate-fade-in">
          <h3 className="text-sm font-semibold text-ink-black mb-4">New Courier Company</h3>
          {addError && (
            <div role="alert" className="flex items-center gap-2 px-3 py-2 mb-4 bg-ink-red-dim rounded border border-ink-red/20">
              <span className="text-xs text-ink-red">{addError}</span>
            </div>
          )}
          <form onSubmit={handleAdd} className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <CourierFields idPrefix="new-courier" draft={addDraft} onChange={setAddDraft} />
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
                {adding ? "Adding…" : "Add courier company"}
              </button>
            </div>
          </form>
        </div>
      )}

      {loading && (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-ink-muted">Loading courier companies…</p>
        </div>
      )}

      {!loading && !loadError && companies.length === 0 && (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-12 text-center">
          <p className="text-sm font-medium text-ink-black mb-2">No courier companies yet</p>
          <p className="text-xs text-ink-muted max-w-sm mx-auto mb-4">
            Add the couriers you hand parcels to. They are kept apart from your customers, so no customer email
            can ever go to a courier.
          </p>
          <button
            onClick={() => setShowAdd(true)}
            className="px-5 py-2.5 bg-ink-green text-white text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all"
          >
            Add First Courier Company
          </button>
        </div>
      )}

      {!loading && companies.length > 0 && (
        <div className="bg-ink-card border border-ink-border rounded">
          <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 border-b border-ink-border text-xs font-medium text-ink-muted uppercase tracking-wide">
            <div className="col-span-3">Courier company</div>
            <div className="col-span-4">Contact</div>
            <div className="col-span-2">Account</div>
            <div className="col-span-1">Status</div>
            <div className="col-span-2 text-right">Actions</div>
          </div>
          <div className="divide-y divide-ink-border">
            {shown.map((c) => (
              <div key={c.id}>
                {editingId === c.id ? (
                  <form onSubmit={handleEdit} className="px-5 py-4 bg-ink-surface/50 animate-fade-in">
                    <p className="text-sm font-semibold text-ink-black mb-3">Edit {c.name}</p>
                    {editError && (
                      <div role="alert" className="flex items-center gap-2 px-3 py-2 mb-3 bg-ink-red-dim rounded border border-ink-red/20">
                        <span className="text-xs text-ink-red">{editError}</span>
                      </div>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <CourierFields idPrefix={`edit-${c.id}`} draft={editDraft} onChange={setEditDraft} />
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
                      c.isActive ? "hover:bg-ink-surface/50" : "opacity-50 bg-ink-surface/30"
                    }`}
                  >
                    <div className="md:col-span-3 min-w-0">
                      <span className="text-sm font-medium text-ink-black block truncate">{c.name}</span>
                      {c.notes && (
                        <span className="block text-xs text-ink-muted mt-0.5 truncate" title={c.notes}>
                          {c.notes}
                        </span>
                      )}
                    </div>
                    <div className="md:col-span-4 min-w-0 text-sm text-ink-black">
                      {c.contactPerson || c.phone || c.email ? (
                        <>
                          {c.contactPerson && <span className="block truncate">{c.contactPerson}</span>}
                          {(c.phone || c.email) && (
                            <span className="block text-xs text-ink-muted truncate">
                              {[c.phone, c.email].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-ink-muted-light">—</span>
                      )}
                    </div>
                    <div className="md:col-span-2 min-w-0">
                      {c.accountNumber ? (
                        <span className="font-mono text-sm text-ink-black truncate block">{c.accountNumber}</span>
                      ) : (
                        <span className="text-xs text-ink-muted-light">—</span>
                      )}
                    </div>
                    <div className="md:col-span-1">
                      <span className={c.isActive ? "status tone-green" : "status tone-idle"}>
                        {c.isActive ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <div className="md:col-span-2 flex items-center md:justify-end gap-1.5 flex-wrap">
                      <button onClick={() => startEdit(c)} className="act">
                        Edit
                      </button>
                      <button onClick={() => toggleActive(c)} className={c.isActive ? "act act-amber" : "act act-green"}>
                        {c.isActive ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => {
                          setDeleting(c);
                          setDeleteError("");
                        }}
                        className="act act-danger"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <Pager
            page={shownPage}
            pageSize={pageSize}
            total={companies.length}
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
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete courier company"
          busyLabel="Deleting…"
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => setDeleting(null)}
          onConfirm={confirmDelete}
        >
          <p>It is removed from your courier companies. This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
