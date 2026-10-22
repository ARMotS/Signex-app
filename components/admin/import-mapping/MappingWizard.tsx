"use client";

/**
 * The mapping wizard: point each Signex field at a column (or a cell) of a
 * sample sheet, see the rows exactly as an import would read them, and save
 * the result as an import template.
 *
 * Every change is previewed by the server (POST /api/import-templates/preview)
 * with the real reader, not a copy of it in the browser — what this screen
 * shows is what an upload will do, down to which invoices have no PDF.
 *
 * Full screen on a phone, a dialog on a tablet or PC.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fieldsFor, SHEET_TYPES, type ImportField, type ImportSheetType } from "@/lib/import-fields";
import { StatusBadge } from "@/components/ui/Chips";
import {
  columnIndexOf,
  columnLetter,
  type DraftTemplate,
  type FieldMapping,
  type PreviewResponse,
  type TemplateSummary,
} from "./types";

/** Sheet types the wizard offers — every type Signex imports. */
export const WIZARD_SHEET_TYPES: ImportSheetType[] = ["TRIP_SHEET", "COURIER_TRIP_SHEET"];

const PREVIEW_DELAY_MS = 350;
const RESULT_ROWS_SHOWN = 50;

type Source = FieldMapping["source"] | "";

const SOURCE_LABELS: Record<FieldMapping["source"], string> = {
  column: "Column",
  cell: "Fixed cell",
  firstValueInColumn: "First value in a column",
  promptAtImport: "Typed in at import",
  filename: "From the file name",
};

function sourcesFor(field: ImportField): FieldMapping["source"][] {
  return field.kind === "column"
    ? ["column", "cell", "promptAtImport"]
    : ["cell", "firstValueInColumn", "promptAtImport", "filename"];
}

const fromSummary = (t: TemplateSummary): DraftTemplate => ({
  worksheet: t.worksheet,
  headerRow: t.headerRow,
  dataStartRow: t.dataStartRow,
  stopAtBlankRows: t.stopAtBlankRows,
  mappings: t.mappings,
});

const requestKey = (draft: DraftTemplate | null, prompts: Record<string, string>) => JSON.stringify({ draft, prompts });

const nameFromFile = (file: File) =>
  file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim().slice(0, 80) || "My layout";

export interface MappingWizardProps {
  /** Fixed when opened from an import, or when editing. */
  sheetType?: ImportSheetType;
  /** A sample already in hand — the sheet an import could not read. */
  file?: File | null;
  /** Edit this template rather than create one. */
  editing?: TemplateSummary | null;
  onClose: () => void;
  onSaved: (template: TemplateSummary) => void;
}

export default function MappingWizard({
  sheetType: fixedType,
  file: initialFile = null,
  editing = null,
  onClose,
  onSaved,
}: MappingWizardProps) {
  const [sheetType, setSheetType] = useState<ImportSheetType>(editing?.sheetType ?? fixedType ?? "TRIP_SHEET");
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<DraftTemplate | null>(editing ? fromSummary(editing) : null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [name, setName] = useState(editing?.name ?? "");
  const [isDefault, setIsDefault] = useState(editing?.isDefault ?? false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const seq = useRef(0);
  const sentKey = useRef("");
  const fileInput = useRef<HTMLInputElement>(null);

  const fields = useMemo(() => fieldsFor(sheetType), [sheetType]);

  // ─── Preview ────────────────────────────────────────────────────────────

  /**
   * Ask the server to read `sample` with `template`. With `adopt`, the answer
   * becomes the draft — the server's detected header row and suggested
   * columns for a sheet seen for the first time.
   */
  const runPreview = useCallback(
    async (
      sample: File,
      type: ImportSheetType,
      template: Partial<DraftTemplate> | null,
      promptValues: Record<string, string>,
      adopt: boolean
    ) => {
      const id = ++seq.current;
      const key = adopt ? "" : requestKey(template as DraftTemplate, promptValues);
      setLoading(true);
      setError(null);
      const form = new FormData();
      form.append("file", sample);
      form.append("sheetType", type);
      if (template) form.append("template", JSON.stringify(template));
      form.append("prompts", JSON.stringify(promptValues));
      try {
        const res = await fetch("/api/import-templates/preview", { method: "POST", body: form });
        const data = await res.json();
        if (id !== seq.current) return; // a newer request is on its way
        if (!res.ok) {
          setError(data.error || "Could not read that file");
          setPreview(null);
          return;
        }
        setPreview(data as PreviewResponse);
        if (adopt) {
          const t = (data as PreviewResponse).template;
          const adopted: DraftTemplate = {
            worksheet: t.worksheet,
            headerRow: t.headerRow,
            dataStartRow: t.dataStartRow,
            stopAtBlankRows: t.stopAtBlankRows,
            mappings: t.mappings,
          };
          const adoptedKey = requestKey(adopted, promptValues);
          sentKey.current = adoptedKey;
          setPreviewKey(adoptedKey);
          setDraft(adopted);
        } else {
          setPreviewKey(key);
        }
      } catch {
        if (id === seq.current) setError("Failed to connect to server");
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    []
  );

  const loadFile = useCallback(
    (sample: File) => {
      setFile(sample);
      setPicking(null);
      setSaveError(null);
      if (!editing) setName((current) => current || nameFromFile(sample));
      if (editing || draft) {
        // Keep the mapping: the new sample is checked against it.
        const current = draft ?? fromSummary(editing!);
        sentKey.current = requestKey(current, prompts);
        void runPreview(sample, sheetType, current, prompts, false);
      } else {
        void runPreview(sample, sheetType, null, prompts, true);
      }
    },
    [draft, editing, prompts, runPreview, sheetType]
  );

  // A file handed over by the import screen is loaded once, on open.
  const loadedInitial = useRef(false);
  useEffect(() => {
    if (initialFile && !loadedInitial.current) {
      loadedInitial.current = true;
      loadFile(initialFile);
    }
  }, [initialFile, loadFile]);

  // Every edit is previewed, a moment after the last keystroke.
  useEffect(() => {
    if (!file || !draft) return;
    const key = requestKey(draft, prompts);
    if (key === sentKey.current) return;
    const timer = setTimeout(() => {
      sentKey.current = key;
      void runPreview(file, sheetType, draft, prompts, false);
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, prompts, file, sheetType, runPreview]);

  // Escape closes, unless a save is in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (picking) setPicking(null);
      else if (!saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, picking, saving]);

  // ─── Editing the draft ──────────────────────────────────────────────────

  const update = (patch: Partial<DraftTemplate>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const setMapping = (key: string, mapping: FieldMapping | null) =>
    setDraft((d) => {
      if (!d) return d;
      const mappings = { ...d.mappings };
      if (mapping) mappings[key] = mapping;
      else delete mappings[key];
      return { ...d, mappings };
    });

  const setHeaderRow = (row: number) => {
    if (!draft || !Number.isInteger(row) || row < 1) return;
    // Data keeps its distance below the headers (usually the next row).
    const gap = Math.max(1, draft.dataStartRow - draft.headerRow);
    update({ headerRow: row, dataStartRow: row + gap });
  };

  /** A different worksheet is a different table: start again from what Signex suggests for it. */
  const chooseWorksheet = (worksheet: string) => {
    if (!file) return;
    setPicking(null);
    void runPreview(file, sheetType, { worksheet }, prompts, true);
  };

  const applySuggestions = () => {
    if (!draft || !preview) return;
    const mappings = { ...draft.mappings };
    for (const [key, suggestion] of Object.entries(preview.suggestions)) {
      if (!mappings[key]) mappings[key] = suggestion;
    }
    update({ mappings });
  };

  const unsuggested = useMemo(
    () => (preview && draft ? Object.keys(preview.suggestions).filter((key) => !draft.mappings[key]) : []),
    [preview, draft]
  );

  const pickCell = (row: number, col: number) => {
    if (!picking || !draft) return;
    setMapping(picking, { ...draft.mappings[picking], source: "cell", cell: `${columnLetter(col)}${row + 1}` });
    setPicking(null);
  };

  // ─── Saving ─────────────────────────────────────────────────────────────

  const pending = !!file && !!draft && requestKey(draft, prompts) !== previewKey;
  const blockers: string[] = [];
  if (!name.trim()) blockers.push("Give the template a name.");
  if (file) {
    if (!preview || !draft) blockers.push("Waiting for the sample to be read.");
    else {
      if (preview.check.errors.length) blockers.push("Fix the problems listed above.");
      if (preview.result.missingColumns.length) blockers.push("Some mapped columns are not in this file.");
    }
  } else if (!editing) {
    blockers.push("Upload a sample sheet.");
  }
  const canSave = blockers.length === 0 && !pending && !loading && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    const body =
      file && draft && preview
        ? { sheetType, name: name.trim(), isDefault, ...draft, headers: preview.headers }
        : { name: name.trim(), isDefault };
    try {
      const res = await fetch(editing ? `/api/import-templates/${editing.id}` : "/api/import-templates", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveError(data.errors?.join(" ") || data.error || "Could not save the template");
        return;
      }
      onSaved(data as TemplateSummary);
    } catch {
      setSaveError("Failed to connect to server");
    } finally {
      setSaving(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────

  const title = editing ? `Edit “${editing.name}”` : "New import template";

  // Portalled to <body>: the wizard opens from inside cards with animations
  // and overflow-hidden, and a transformed ancestor makes `fixed` relative to
  // it — the overlay was clipped to the card instead of covering the screen.
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex bg-black/50 animate-fade-in sm:items-center sm:justify-center sm:p-6"
      onClick={() => !saving && onClose()}
    >
      <div
        className="bg-white w-full h-full flex flex-col overflow-hidden shadow-xl sm:h-auto sm:max-h-[94vh] sm:max-w-7xl sm:rounded-lg"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-ink-border">
          <div className="min-w-0 flex-1">
            <h3 className="font-mono text-sm font-medium text-ink-black truncate">{title}</h3>
            <p className="text-xs text-ink-muted mt-0.5">
              Point each Signex field at the column it is in. Every later upload with this layout is read
              the same way.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="act act-icon" aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = "";
              if (picked) loadFile(picked);
            }}
          />

          {!file ? (
            <SamplePrompt
              editing={!!editing}
              sheetType={sheetType}
              fixedType={!!fixedType || !!editing}
              onSheetType={setSheetType}
              onChoose={() => fileInput.current?.click()}
              onDrop={loadFile}
            />
          ) : (
            <div className="p-4 sm:p-6 space-y-5">
              {/* Sheet controls */}
              <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
                <div className="min-w-0">
                  <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">Sample</span>
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-mono text-ink-black truncate max-w-[16rem]" title={file.name}>
                      {file.name}
                    </span>
                    <button type="button" className="act" onClick={() => fileInput.current?.click()}>
                      Change
                    </button>
                  </div>
                </div>

                {preview && preview.sheetNames.length > 1 && (
                  <label className="block">
                    <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">Worksheet</span>
                    <select
                      value={draft?.worksheet ?? preview.worksheet ?? ""}
                      onChange={(e) => chooseWorksheet(e.target.value)}
                      className="px-2 py-1.5 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
                    >
                      {preview.sheetNames.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {draft && (
                  <>
                    <NumberField
                      label="Headers on row"
                      value={draft.headerRow}
                      min={1}
                      onChange={(n) => setHeaderRow(n)}
                    />
                    <NumberField
                      label="Data starts on row"
                      value={draft.dataStartRow}
                      min={draft.headerRow + 1}
                      onChange={(n) => update({ dataStartRow: n })}
                    />
                    <NumberField
                      label="Stop after blank rows"
                      value={draft.stopAtBlankRows}
                      min={0}
                      onChange={(n) => update({ stopAtBlankRows: n })}
                      hint="0 reads to the end"
                    />
                  </>
                )}

                {unsuggested.length > 0 && (
                  <button type="button" className="act act-green" onClick={applySuggestions}>
                    Fill in {unsuggested.length} suggested {unsuggested.length === 1 ? "column" : "columns"}
                  </button>
                )}

                <span className="text-xs font-mono text-ink-muted ml-auto" aria-live="polite">
                  {loading || pending ? "Reading…" : preview ? `${preview.rowCount} rows in the sheet` : ""}
                </span>
              </div>

              {error && (
                <div className="px-3 py-2 text-sm text-ink-red bg-ink-red-dim border border-ink-red/30 rounded">{error}</div>
              )}

              {draft && preview && (
                <div className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
                  {/* Fields */}
                  <section aria-label="Fields" className="space-y-2">
                    <h4 className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">
                      {SHEET_TYPES[sheetType].label} fields
                    </h4>
                    {fields.map((field) => (
                      <FieldRow
                        key={field.key}
                        field={field}
                        mapping={draft.mappings[field.key]}
                        preview={preview}
                        prompt={prompts[field.key] ?? ""}
                        picking={picking === field.key}
                        onChange={(m) => setMapping(field.key, m)}
                        onPrompt={(v) => setPrompts((p) => ({ ...p, [field.key]: v }))}
                        onPick={() => setPicking(picking === field.key ? null : field.key)}
                      />
                    ))}
                  </section>

                  {/* Sheet + result */}
                  <section aria-label="Preview" className="space-y-5 min-w-0">
                    <SheetGrid
                      preview={preview}
                      draft={draft}
                      fields={fields}
                      picking={picking ? fields.find((f) => f.key === picking)?.label ?? null : null}
                      onPickCell={pickCell}
                      onHeaderRow={setHeaderRow}
                      onCancelPick={() => setPicking(null)}
                    />
                    <ResultPanel preview={preview} draft={draft} fields={fields} />
                  </section>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-ink-border bg-ink-surface/50 px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 min-w-0 basis-full sm:basis-auto">
            <span className="text-[11px] font-mono text-ink-muted uppercase tracking-wide shrink-0">Name</span>
            <input
              type="text"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Pretoria depot sheet"
              className="min-w-0 w-full sm:w-64 px-3 py-1.5 text-sm font-mono bg-white border border-ink-border rounded focus:outline-none focus:border-ink-green"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-black">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
            Default for uploads
          </label>
          <div className="flex-1 min-w-[10rem] text-xs text-ink-muted" aria-live="polite">
            {saveError ? <span className="text-ink-red">{saveError}</span> : blockers[0] ?? (editing && !file ? "Upload a sample to change the columns." : "")}
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!canSave}
            className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
              canSave ? "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]" : "bg-ink-border text-ink-muted cursor-not-allowed"
            }`}
          >
            {saving ? "Saving…" : editing ? "Save changes" : "Save template"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

function SamplePrompt({
  editing,
  sheetType,
  fixedType,
  onSheetType,
  onChoose,
  onDrop,
}: {
  editing: boolean;
  sheetType: ImportSheetType;
  fixedType: boolean;
  onSheetType: (t: ImportSheetType) => void;
  onChoose: () => void;
  onDrop: (f: File) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <div className="p-4 sm:p-6 space-y-4">
      {!fixedType && WIZARD_SHEET_TYPES.length > 1 && (
        <label className="block max-w-xs">
          <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">Sheet type</span>
          <select
            value={sheetType}
            onChange={(e) => onSheetType(e.target.value as ImportSheetType)}
            className="w-full px-2 py-1.5 text-sm font-mono bg-ink-surface border border-ink-border rounded"
          >
            {WIZARD_SHEET_TYPES.map((t) => (
              <option key={t} value={t}>
                {SHEET_TYPES[t].label}
              </option>
            ))}
          </select>
        </label>
      )}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const dropped = e.dataTransfer.files?.[0];
          if (dropped) onDrop(dropped);
        }}
        className={`border-2 border-dashed rounded-lg px-6 py-12 text-center transition-colors ${
          over ? "border-ink-green bg-ink-green-dim" : "border-ink-border"
        }`}
      >
        <p className="text-sm text-ink-black font-medium">
          {editing ? "Upload a sample of this layout to change its columns" : "Upload a sample sheet"}
        </p>
        <p className="text-xs text-ink-muted mt-1">
          An Excel (.xlsx, .xls) or CSV file exported the way you will upload them. Nothing is imported.
        </p>
        <button type="button" onClick={onChoose} className="act act-primary mt-4">
          Choose file
        </button>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  onChange: (n: number) => void;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">{label}</span>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= min) onChange(n);
        }}
        title={hint}
        className="w-20 px-2 py-1.5 text-sm font-mono bg-ink-surface border border-ink-border rounded focus:outline-none focus:border-ink-green"
      />
    </label>
  );
}

const inputClass =
  "px-2 py-1.5 text-sm font-mono bg-white border border-ink-border rounded focus:outline-none focus:border-ink-green";

function FieldRow({
  field,
  mapping,
  preview,
  prompt,
  picking,
  onChange,
  onPrompt,
  onPick,
}: {
  field: ImportField;
  mapping: FieldMapping | undefined;
  preview: PreviewResponse;
  prompt: string;
  picking: boolean;
  onChange: (m: FieldMapping | null) => void;
  onPrompt: (v: string) => void;
  onPick: () => void;
}) {
  const source: Source = mapping?.source ?? "";
  const missing = preview.result.missingColumns.find((m) => m.field === field.key);
  const resolved = preview.result.columns[field.key];
  const columnCount = Math.min(
    60,
    Math.max(preview.headers.length, ...preview.grid.map((r) => r.length), 1)
  );

  const sample =
    field.kind === "header" || (source && source !== "column")
      ? field.kind === "header"
        ? preview.result.header[field.key]
        : preview.result.rows[0]?.values[field.key]
      : preview.result.rows.find((r) => {
          const v = r.values[field.key];
          return v !== "" && v !== null && v !== 0;
        })?.values[field.key];

  const choose = (next: Source) => {
    if (!next) return onChange(null);
    const keep: FieldMapping = { source: next };
    if (mapping?.regex) keep.regex = mapping.regex;
    if (mapping?.dateFormat) keep.dateFormat = mapping.dateFormat;
    if (next === "column" || next === "firstValueInColumn") {
      if (mapping?.column) keep.column = mapping.column;
      if (mapping?.columnLetter) keep.columnLetter = mapping.columnLetter;
      if (next === "column" && mapping?.fillDown) keep.fillDown = true;
      if (next === "column" && mapping?.splitOn) keep.splitOn = mapping.splitOn;
    }
    if (next === "cell" && mapping?.cell) keep.cell = mapping.cell;
    onChange(keep);
  };

  const chooseColumn = (index: number) => {
    const header = String(preview.headers[index] ?? "").trim();
    onChange({
      ...mapping,
      source: mapping?.source === "firstValueInColumn" ? "firstValueInColumn" : "column",
      column: header || undefined,
      columnLetter: columnLetter(index),
    });
  };

  // A named column this file does not have shows as unchosen, not as whatever
  // sits under its old letter — that column is not what will be read.
  const selectedColumn = resolved ?? (missing ? -1 : columnIndexOf(mapping?.columnLetter) ?? -1);
  const readsColumn = source === "column" || source === "firstValueInColumn";
  const needed = field.mustMap && !mapping;

  return (
    <div className={`border rounded px-3 py-2.5 ${needed || missing ? "border-ink-red/40 bg-ink-red-dim/40" : "border-ink-border"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-ink-black">{field.label}</span>
        {field.mustMap && <StatusBadge tone={mapping ? "idle" : "red"}>Required</StatusBadge>}
        <select
          value={source}
          onChange={(e) => choose(e.target.value as Source)}
          aria-label={`Where ${field.label} comes from`}
          className={`${inputClass} ml-auto`}
        >
          <option value="">{field.kind === "column" ? "Not on this sheet" : "Not used"}</option>
          {sourcesFor(field).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {readsColumn && (
        <select
          value={selectedColumn}
          onChange={(e) => chooseColumn(Number(e.target.value))}
          aria-label={`Column for ${field.label}`}
          className={`${inputClass} w-full mt-2`}
        >
          <option value={-1}>Choose a column…</option>
          {Array.from({ length: columnCount }, (_, i) => (
            <option key={i} value={i}>
              {columnLetter(i)} · {String(preview.headers[i] ?? "").trim() || "(no header)"}
            </option>
          ))}
        </select>
      )}

      {source === "cell" && (
        <div className="flex items-center gap-2 mt-2">
          <input
            type="text"
            value={mapping?.cell ?? ""}
            onChange={(e) => onChange({ ...mapping!, cell: e.target.value.toUpperCase() })}
            placeholder="e.g. F2"
            aria-label={`Cell for ${field.label}`}
            className={`${inputClass} w-24`}
          />
          <button type="button" onClick={onPick} className={`act ${picking ? "act-amber" : ""}`}>
            {picking ? "Click a cell…" : "Pick in sheet"}
          </button>
        </div>
      )}

      {source === "promptAtImport" && (
        <input
          type="text"
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          placeholder="Asked at each import — type a value to try it"
          aria-label={`Try a value for ${field.label}`}
          className={`${inputClass} w-full mt-2`}
        />
      )}

      {source === "filename" && (
        <p className="text-xs text-ink-muted mt-2">
          Read from the uploaded file&apos;s name — e.g. 200189 from cts-200189-p5.xlsx.
        </p>
      )}

      {missing && (
        <p className="text-xs text-ink-red mt-2">This file has no “{missing.column}” column.</p>
      )}
      {!missing && source && sample !== undefined && sample !== null && sample !== "" && (
        <p className="text-xs text-ink-muted mt-2 truncate">
          e.g. <span className="font-mono text-ink-black">{String(sample)}</span>
        </p>
      )}
      {field.help && !source && <p className="text-xs text-ink-muted mt-1.5">{field.help}</p>}

      {source && (
        <details className="mt-2 group">
          <summary className="text-xs text-ink-muted cursor-pointer select-none hover:text-ink-black">More options</summary>
          <div className="mt-2 space-y-2">
            {source === "column" && (
              <label className="flex items-center gap-2 text-xs text-ink-black">
                <input
                  type="checkbox"
                  checked={!!mapping?.fillDown}
                  onChange={(e) => onChange({ ...mapping!, fillDown: e.target.checked || undefined })}
                />
                Fill down — a blank cell takes the value above (merged cells)
              </label>
            )}
            {source === "column" && (field.valueType === "reference" || field.valueType === "text") && (
              <label className="block text-xs text-ink-black">
                One cell lists several — split on
                <input
                  type="text"
                  value={(mapping?.splitOn ?? []).join(" ")}
                  onChange={(e) => {
                    const splitOn = e.target.value.split(/\s+/).filter(Boolean).slice(0, 5);
                    onChange({ ...mapping!, splitOn: splitOn.length ? splitOn : undefined });
                  }}
                  placeholder=", / ;"
                  className={`${inputClass} w-24 ml-2`}
                />
              </label>
            )}
            {field.valueType === "date" && (
              <label className="block text-xs text-ink-black">
                Date format
                <input
                  type="text"
                  value={mapping?.dateFormat ?? ""}
                  onChange={(e) => onChange({ ...mapping!, dateFormat: e.target.value || undefined })}
                  placeholder="dd/MM/yyyy"
                  className={`${inputClass} w-32 ml-2`}
                />
              </label>
            )}
            <label className="block text-xs text-ink-black">
              Pattern
              <input
                type="text"
                value={mapping?.regex ?? ""}
                onChange={(e) => onChange({ ...mapping!, regex: e.target.value || undefined })}
                placeholder="e.g. (\d+)"
                spellCheck={false}
                className={`${inputClass} w-40 ml-2`}
              />
              <span className="block text-ink-muted mt-1">
                Pulls the value out of a longer cell — the part in brackets.
              </span>
            </label>
          </div>
        </details>
      )}
    </div>
  );
}

function SheetGrid({
  preview,
  draft,
  fields,
  picking,
  onPickCell,
  onHeaderRow,
  onCancelPick,
}: {
  preview: PreviewResponse;
  draft: DraftTemplate;
  fields: ImportField[];
  picking: string | null;
  onPickCell: (row: number, col: number) => void;
  onHeaderRow: (row: number) => void;
  onCancelPick: () => void;
}) {
  const width = Math.min(40, Math.max(1, ...preview.grid.map((r) => r.length)));
  const labelsByColumn = new Map<number, string[]>();
  for (const field of fields) {
    const col = preview.result.columns[field.key];
    if (col === undefined) continue;
    labelsByColumn.set(col, [...(labelsByColumn.get(col) ?? []), field.label]);
  }
  const cellLabels = new Map<string, string[]>();
  for (const field of fields) {
    const cell = draft.mappings[field.key]?.source === "cell" ? draft.mappings[field.key]?.cell : undefined;
    if (cell) cellLabels.set(cell.toUpperCase(), [...(cellLabels.get(cell.toUpperCase()) ?? []), field.label]);
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <h4 className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Sheet</h4>
        {picking ? (
          <span className="text-xs text-ink-black">
            Click the cell that holds <strong>{picking}</strong>{" "}
            <button type="button" className="act ml-1" onClick={onCancelPick}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="text-xs text-ink-muted">Click a row number to make it the header row.</span>
        )}
      </div>
      <div className="overflow-auto border border-ink-border rounded max-h-[22rem]">
        <table className="text-xs font-mono border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-ink-surface">
              <th className="px-2 py-1 border-b border-r border-ink-border text-ink-muted font-normal sticky left-0 bg-ink-surface" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} className="px-2 py-1 border-b border-r border-ink-border text-left font-normal align-bottom min-w-[5rem]">
                  <span className="text-ink-muted">{columnLetter(c)}</span>
                  {labelsByColumn.get(c)?.map((l) => (
                    <span key={l} className="block text-[10px] text-ink-green font-medium truncate max-w-[9rem]">
                      → {l}
                    </span>
                  ))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.grid.map((row, r) => {
              const rowNumber = r + 1;
              const isHeader = rowNumber === draft.headerRow;
              const isData = rowNumber >= draft.dataStartRow;
              return (
                <tr key={r} className={isHeader ? "bg-ink-amber-dim" : isData ? "" : "text-ink-muted"}>
                  <th className="px-2 py-1 border-b border-r border-ink-border font-normal sticky left-0 bg-ink-surface">
                    <button
                      type="button"
                      onClick={() => onHeaderRow(rowNumber)}
                      title="Make this the header row"
                      className={`min-w-[1.5rem] ${isHeader ? "text-ink-black font-semibold" : "text-ink-muted hover:text-ink-black"}`}
                    >
                      {rowNumber}
                    </button>
                  </th>
                  {Array.from({ length: width }, (_, c) => {
                    const ref = `${columnLetter(c)}${rowNumber}`;
                    const labels = cellLabels.get(ref);
                    const text = row[c] ?? "";
                    return (
                      <td
                        key={c}
                        onClick={picking ? () => onPickCell(r, c) : undefined}
                        title={text || undefined}
                        className={`px-2 py-1 border-b border-r border-ink-border whitespace-nowrap max-w-[12rem] truncate ${
                          picking ? "cursor-crosshair hover:bg-ink-green-dim" : ""
                        } ${labels ? "bg-ink-green-dim outline outline-1 outline-ink-green" : ""} ${isHeader ? "font-semibold text-ink-black" : ""}`}
                      >
                        {text}
                        {labels && <span className="block text-[10px] text-ink-green">{labels.join(", ")}</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {preview.rowCount > preview.grid.length && (
        <p className="text-xs text-ink-muted mt-1">First {preview.grid.length} of {preview.rowCount} rows.</p>
      )}
    </div>
  );
}

function ResultPanel({
  preview,
  draft,
  fields,
}: {
  preview: PreviewResponse;
  draft: DraftTemplate;
  fields: ImportField[];
}) {
  const { check, result, trip } = preview;
  const rowFields = fields.filter((f) => f.kind === "column" && draft.mappings[f.key]);
  const headerFields = fields.filter((f) => f.kind === "header" && draft.mappings[f.key]);
  const issueAt = new Map<string, string>();
  for (const issue of result.issues) {
    if (issue.rowNumber !== null) issueAt.set(`${issue.rowNumber}:${issue.field}`, issue.message);
  }
  const shown = result.rows.slice(0, RESULT_ROWS_SHOWN);

  return (
    <div className="space-y-3">
      <h4 className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">What an import will read</h4>

      {check.errors.length > 0 && (
        <ul className="px-3 py-2 text-sm text-ink-red bg-ink-red-dim border border-ink-red/30 rounded space-y-0.5">
          {check.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {check.warnings.length > 0 && (
        <ul className="px-3 py-2 text-sm text-ink-black bg-ink-amber-dim border border-ink-amber/40 rounded space-y-0.5">
          {check.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {headerFields.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {headerFields.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-ink-muted">{f.label}</dt>
              <dd className="font-mono text-ink-black">{String(result.header[f.key] ?? "") || "—"}</dd>
            </div>
          ))}
        </dl>
      )}

      {rowFields.length > 0 ? (
        <div className="overflow-auto border border-ink-border rounded max-h-[22rem]">
          <table className="text-xs border-collapse w-full">
            <thead className="sticky top-0 bg-ink-surface">
              <tr>
                <th className="px-2 py-1.5 text-left font-mono font-normal text-ink-muted border-b border-ink-border">Row</th>
                {rowFields.map((f) => (
                  <th key={f.key} className="px-2 py-1.5 text-left font-mono font-normal text-ink-muted border-b border-ink-border whitespace-nowrap">
                    {f.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((row, i) => (
                <tr key={`${row.rowNumber}-${i}`} className="border-b border-ink-border last:border-0">
                  <td className="px-2 py-1 font-mono text-ink-muted">{row.rowNumber}</td>
                  {rowFields.map((f) => {
                    const problem = issueAt.get(`${row.rowNumber}:${f.key}`);
                    const value = row.values[f.key];
                    return (
                      <td
                        key={f.key}
                        title={problem}
                        className={`px-2 py-1 font-mono whitespace-nowrap max-w-[14rem] truncate ${problem ? "bg-ink-red-dim text-ink-red" : "text-ink-black"}`}
                      >
                        {value === null || value === "" ? <span className="text-ink-muted">—</span> : String(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-ink-muted">Map a column to see the rows.</p>
      )}
      <p className="text-xs text-ink-muted">
        {result.rowCount} {result.rowCount === 1 ? "row" : "rows"}
        {result.rowCount > shown.length ? ` · first ${shown.length} shown` : ""}
        {result.issueCount > 0 ? ` · ${result.issueCount} ${result.issueCount === 1 ? "problem" : "problems"}` : ""}
      </p>

      {result.issues.some((i) => i.rowNumber === null) && (
        <ul className="text-sm text-ink-red space-y-0.5">
          {result.issues
            .filter((i) => i.rowNumber === null)
            .map((i) => (
              <li key={`${i.field}:${i.message}`}>{i.message}</li>
            ))}
        </ul>
      )}

      {trip && <TripSummary trip={trip} />}
    </div>
  );
}

function TripSummary({ trip }: { trip: NonNullable<PreviewResponse["trip"]> }) {
  if ("error" in trip && trip.error) {
    return <p className="text-sm text-ink-red">{trip.error}</p>;
  }
  if (!("drivers" in trip)) return null;
  const unassigned = trip.drivers.find((d) => d.driverId === "__unassigned__");
  const matched = trip.drivers.filter((d) => d.driverId !== "__unassigned__");
  return (
    <div className="border border-ink-border rounded px-3 py-2.5 text-sm space-y-1.5">
      <p className="text-ink-black">
        {trip.totalRows} {trip.totalRows === 1 ? "job" : "jobs"} for{" "}
        {matched.length ? matched.map((d) => `${d.driverName} (${d.stops})`).join(", ") : "no driver Signex knows"}
        {trip.totalCollections > 0 && ` · ${trip.totalCollections} ${trip.totalCollections === 1 ? "collection" : "collections"}`}
      </p>
      {unassigned && (
        <p style={{ color: "var(--tone-amber-fg)" }}>
          {unassigned.stops} {unassigned.stops === 1 ? "stop has" : "stops have"} no matching driver — they would be
          unassigned.
        </p>
      )}
      <p className={trip.missingInvoices.length ? "text-ink-red" : "text-ink-green"}>
        {trip.matchedInvoices} {trip.matchedInvoices === 1 ? "invoice" : "invoices"} found
        {trip.missingInvoices.length > 0 &&
          ` · ${trip.missingInvoices.length} with no PDF: ${trip.missingInvoices
            .slice(0, 6)
            .map((m) => m.invoiceNumber)
            .join(", ")}${trip.missingInvoices.length > 6 ? "…" : ""}`}
      </p>
    </div>
  );
}
