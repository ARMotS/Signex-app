"use client";

/**
 * Settings → Import Templates: the layouts this scope's uploads can be read
 * with. The built-in trip sheet layout is listed beside the saved ones because
 * it is always there underneath them — an upload no template fits is read the
 * way trip sheets always have been. See lib/sheet-templates.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SHEET_TYPES, fieldsFor } from "@/lib/import-fields";
import { StatusBadge } from "@/components/ui/Chips";
import MappingWizard, { WIZARD_SHEET_TYPES } from "./MappingWizard";
import type { BuiltInLayout, TemplateSummary } from "./types";

type WizardState = { editing: TemplateSummary | null } | null;

/** What each built-in layout reads, in the office's words. */
const BUILT_IN_COLUMNS: Record<string, string> = {
  TRIP_SHEET: "Date · Driver · REG No · Customer · INVOICENO · COLLECTNO · NOP, found by their usual names.",
  COURIER_TRIP_SHEET:
    "Waybill No · Customer · Invoice No · Date · NOP, found by their usual names; the sheet number from the file name (cts-200189-p5).",
};

export default function ImportTemplatesSettings() {
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [builtIn, setBuiltIn] = useState<BuiltInLayout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardState>(null);
  const [confirmDelete, setConfirmDelete] = useState<TemplateSummary | null>(null);

  const load = useCallback(
    () =>
      fetch("/api/import-templates")
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          setTemplates((data.templates as TemplateSummary[]).filter((t) => WIZARD_SHEET_TYPES.includes(t.sheetType)));
          setBuiltIn((data.builtIn as BuiltInLayout[]).filter((b) => WIZARD_SHEET_TYPES.includes(b.sheetType)));
          setError(null);
        })
        .catch(() => setError("Could not load import templates"))
        .finally(() => setLoading(false)),
    []
  );

  useEffect(() => {
    void load();
  }, [load]);

  const setDefault = async (template: TemplateSummary, isDefault: boolean) => {
    setBusy(template.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/import-templates/${template.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await load();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not change the default");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (template: TemplateSummary) => {
    setBusy(template.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/import-templates/${template.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error);
      setConfirmDelete(null);
      setNotice(`Deleted “${template.name}”. Trip sheets already read with it are unchanged.`);
      await load();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Could not delete the template");
    } finally {
      setBusy(null);
    }
  };

  const mappedCount = (t: TemplateSummary) =>
    fieldsFor(t.sheetType).filter((f) => t.mappings[f.key]).length;

  return (
    <div className="mt-6 bg-ink-card border border-ink-border rounded overflow-hidden">
      <div className="px-6 py-4 border-b border-ink-border flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">Import Templates</h2>
          <p className="text-xs text-ink-muted mt-1">
            How Signex reads a spreadsheet exported in your own layout. Upload a sample once, point each field at
            its column, and every later upload with that layout is read the same way.
          </p>
        </div>
        <button type="button" className="act act-primary shrink-0" onClick={() => setWizard({ editing: null })}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New template
        </button>
      </div>

      <ul className="divide-y divide-ink-border">
        {builtIn.map((b) => (
          <li key={`builtin-${b.sheetType}`} className="px-6 py-3.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm text-ink-black font-medium">{b.name}</span>
            <StatusBadge tone="idle">Built in</StatusBadge>
            {!templates.some((t) => t.sheetType === b.sheetType && t.isDefault) && (
              <StatusBadge tone="green">Default</StatusBadge>
            )}
            <p className="basis-full text-xs text-ink-muted">
              {BUILT_IN_COLUMNS[b.sheetType]} Used for any {SHEET_TYPES[b.sheetType].label.toLowerCase()} no template
              fits.
            </p>
          </li>
        ))}

        {templates.map((t) => (
          <li key={t.id} className="px-6 py-3.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* Wide enough that on a phone the actions wrap beneath it. */}
            <div className="min-w-[15rem] flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-black font-medium truncate">{t.name}</span>
                {t.isDefault && <StatusBadge tone="green">Default</StatusBadge>}
              </div>
              <p className="text-xs text-ink-muted mt-0.5">
                {SHEET_TYPES[t.sheetType].label} · headers on row {t.headerRow}
                {t.worksheet ? ` of “${t.worksheet}”` : ""} · {mappedCount(t)} fields · updated{" "}
                {new Date(t.updatedAt).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })}
                {t.createdByName ? ` · by ${t.createdByName}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="act" disabled={busy === t.id} onClick={() => setWizard({ editing: t })}>
                Edit
              </button>
              <button
                type="button"
                className="act"
                disabled={busy === t.id}
                onClick={() => setDefault(t, !t.isDefault)}
                title={t.isDefault ? "Uploads no template fits go back to the built-in layout" : undefined}
              >
                {t.isDefault ? "Remove default" : "Make default"}
              </button>
              <button type="button" className="act act-danger" disabled={busy === t.id} onClick={() => setConfirmDelete(t)}>
                Delete
              </button>
            </div>
          </li>
        ))}

        {!loading && templates.length === 0 && (
          <li className="px-6 py-4 text-sm text-ink-muted">
            No templates yet. Uploads are read with the built-in layout until you add one.
          </li>
        )}
      </ul>

      {(error || notice) && (
        <div className={`px-6 py-3 border-t border-ink-border text-sm font-mono ${error ? "text-ink-red" : "text-ink-green"}`}>
          {error ? `✕ ${error}` : `✓ ${notice}`}
        </div>
      )}

      {wizard && (
        <MappingWizard
          editing={wizard.editing}
          onClose={() => setWizard(null)}
          onSaved={(saved) => {
            setWizard(null);
            setError(null);
            setNotice(`Saved “${saved.name}”.`);
            void load();
          }}
        />
      )}

      {confirmDelete &&
        createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in"
          onClick={() => busy === null && setConfirmDelete(null)}
        >
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <h3 className="font-mono text-sm font-medium text-ink-black">Delete “{confirmDelete.name}”?</h3>
              <p className="text-sm text-ink-muted mt-2">
                Uploads in this layout will no longer be recognised
                {confirmDelete.isDefault ? ", and the built-in layout becomes the default again" : ""}. Trip sheets
                already read with it keep the record of how they were read.
              </p>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-ink-border bg-ink-surface/50">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                disabled={busy !== null}
                className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => remove(confirmDelete)}
                disabled={busy !== null}
                className="px-5 py-2.5 text-sm font-mono font-medium rounded bg-ink-red text-white hover:opacity-90"
              >
                {busy === confirmDelete.id ? "Deleting…" : "Delete template"}
              </button>
            </div>
          </div>
        </div>,
          // Out of the card, as the wizard is — see MappingWizard.
          document.body
        )}
    </div>
  );
}
