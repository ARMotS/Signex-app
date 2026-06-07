"use client";

/**
 * ContactsTable.tsx
 * Searchable, paginated contacts table with edit/remove actions.
 */

import { useCallback, useEffect, useState } from "react";
import { AddContactPanel } from "./AddContactPanel";

interface Contact {
  id: string;
  companyName: string;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  altPhone?: string | null;
  address?: string | null;
  notes?: string | null;
  source: "MANUAL" | "SPREADSHEET" | "AUTO_CREATED";
  createdAt: string;
  _count: { stops: number };
}

const SOURCE_BADGE: Record<Contact["source"], { label: string; cls: string }> = {
  MANUAL: { label: "Manual", cls: "bg-zinc-100 text-zinc-600 border-zinc-200" },
  SPREADSHEET: { label: "Import", cls: "bg-blue-100 text-blue-700 border-blue-200" },
  AUTO_CREATED: { label: "Auto", cls: "bg-amber-100 text-amber-700 border-amber-200" },
};

export function ContactsTable() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [missingEmail, setMissingEmail] = useState(false);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(LIMIT),
        ...(search && { search }),
        ...(missingEmail && { missingEmail: "true" }),
      });
      const res = await fetch(`/api/contacts?${params}`);
      const data = await res.json();
      setContacts(data.contacts ?? []);
      setTotal(data.total ?? 0);
    } finally {
      setLoading(false);
    }
  }, [page, search, missingEmail]);

  useEffect(() => { load(); }, [load]);

  // Debounce search
  useEffect(() => {
    setPage(1);
  }, [search, missingEmail]);

  async function remove(id: string, name: string) {
    if (!confirm(`Remove "${name}" from contacts? This cannot be undone.`)) return;
    await fetch(`/api/contacts/${id}`, { method: "DELETE" });
    load();
  }

  function openAdd() { setEditing(null); setPanelOpen(true); }
  function openEdit(c: Contact) { setEditing(c); setPanelOpen(true); }

  const missingEmailCount = contacts.filter((c) => !c.email).length;
  const totalPages = Math.ceil(total / LIMIT);
  const from = (page - 1) * LIMIT + 1;
  const to = Math.min(page * LIMIT, total);

  return (
    <>
      <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
        {/* Toolbar */}
        <div className="px-5 py-4 border-b border-zinc-100 flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="relative flex-1 max-w-xs">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="search"
              placeholder="Search contacts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-zinc-50 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-transparent"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={missingEmail}
              onChange={(e) => setMissingEmail(e.target.checked)}
              className="rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
            />
            Missing email only
          </label>
          <button
            onClick={openAdd}
            className="ml-auto flex items-center gap-2 px-4 py-2 bg-zinc-900 text-white text-sm font-medium rounded-lg hover:bg-zinc-800 transition-colors font-mono whitespace-nowrap"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Add contact
          </button>
        </div>

        {/* Missing email banner */}
        {missingEmailCount > 0 && !missingEmail && (
          <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-100 flex items-center gap-2 text-xs text-amber-800">
            <svg className="w-3.5 h-3.5 text-amber-500 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>
              {missingEmailCount} contact{missingEmailCount !== 1 ? "s" : ""} on this page {missingEmailCount !== 1 ? "are" : "is"} missing an email address.{" "}
              <button
                onClick={() => setMissingEmail(true)}
                className="underline font-medium hover:text-amber-900 transition-colors"
              >
                Show only
              </button>
            </span>
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50">
              <tr>
                {["Company", "Contact Person", "Email", "Phone", "Source", "Deliveries", ""].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-medium text-zinc-500 border-b border-zinc-100 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-zinc-400">
                    <div className="w-6 h-6 border-2 border-zinc-200 border-t-zinc-500 rounded-full animate-spin mx-auto" />
                  </td>
                </tr>
              ) : contacts.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-zinc-400">
                    {search || missingEmail ? "No contacts match your filter." : "No contacts yet. Add one or import a file."}
                  </td>
                </tr>
              ) : (
                contacts.map((c) => {
                  const badge = SOURCE_BADGE[c.source];
                  return (
                    <tr key={c.id} className="hover:bg-zinc-50 transition-colors group">
                      <td className="px-4 py-3 font-medium text-zinc-900 max-w-[200px] truncate">{c.companyName}</td>
                      <td className="px-4 py-3 text-zinc-600">{c.contactPerson || <span className="text-zinc-300">—</span>}</td>
                      <td className="px-4 py-3">
                        {c.email
                          ? <span className="text-zinc-600">{c.email}</span>
                          : <span className="text-amber-600 font-medium text-xs">Missing</span>}
                      </td>
                      <td className="px-4 py-3 text-zinc-600">{c.phone || <span className="text-zinc-300">—</span>}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-600 tabular-nums">{c._count.stops}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEdit(c)}
                            title="Edit"
                            className="w-7 h-7 flex items-center justify-center rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => remove(c.id, c.companyName)}
                            title="Remove"
                            className="w-7 h-7 flex items-center justify-center rounded hover:bg-red-50 text-zinc-400 hover:text-red-600 transition-colors"
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                              <path d="M10 11v6M14 11v6" />
                              <path d="M9 6V4h6v2" />
                            </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > 0 && (
          <div className="px-5 py-3 border-t border-zinc-100 flex items-center justify-between text-xs text-zinc-500">
            <span>{from}–{to} of {total}</span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1.5 rounded border border-zinc-200 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ← Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1.5 rounded border border-zinc-200 hover:bg-zinc-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </div>

      <AddContactPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        contact={editing}
        onSaved={() => { setPanelOpen(false); load(); }}
      />
    </>
  );
}
