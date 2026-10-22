"use client";

/**
 * Upload a courier trip sheet: read it, show what will be imported and what
 * needs fixing, then import. A layout Signex does not know opens the template
 * wizard on the same file. See lib/courier-import.ts.
 */

import { useRef, useState } from "react";
import Link from "next/link";
import MappingWizard from "@/components/admin/import-mapping/MappingWizard";
import type { TemplatePrompt, TemplateSummary } from "@/components/admin/import-mapping/types";
import CourierStatusBadge, { formatSheetDate, type CourierStatus } from "./CourierStatusBadge";

interface Issue {
  code: string;
  level: "block" | "warning";
  invoiceNo?: string;
  message: string;
}

interface Preview {
  template: { id: string; name: string; prompts: TemplatePrompt[] };
  sheet: {
    courierSheetNo: string;
    sheetDate: string;
    courierCompany: string | null;
    customerName: string;
    waybills: string[];
    parcels: number | null;
  };
  lines: { lineNo: number; invoiceNo: string; invoiceDate: string | null; waybillNo: string; invoiceFile: string | null }[];
  contact: { id: string; companyName: string; email: string | null } | null;
  issues: Issue[];
  status: CourierStatus;
  duplicateOf: { id: string; status: CourierStatus } | null;
}

interface Problem {
  code: string;
  message: string;
  template?: { id: string; name: string };
  customers?: string[];
}

const TEMPLATE_CODES = new Set(["NEEDS_TEMPLATE", "MISSING_COLUMNS"]);

export default function CourierUpload({ onImported }: { onImported: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [templateId, setTemplateId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [wizard, setWizard] = useState<{ editing: TemplateSummary | null } | null>(null);

  const send = async (
    sample: File,
    action: "preview" | "import",
    opts: { templateId?: string; prompts?: Record<string, string> } = {}
  ) => {
    const form = new FormData();
    form.append("file", sample);
    form.append("action", action);
    if (opts.templateId) form.append("templateId", opts.templateId);
    form.append("prompts", JSON.stringify(opts.prompts ?? {}));
    const res = await fetch("/api/courier", { method: "POST", body: form });
    return { res, data: await res.json() };
  };

  const read = async (sample: File, opts: { templateId?: string; prompts?: Record<string, string> } = {}) => {
    setFile(sample);
    setBusy(true);
    setProblem(null);
    setPreview(null);
    try {
      const { res, data } = await send(sample, "preview", opts);
      if (!res.ok) {
        setProblem({ code: data.code, message: data.error, template: data.template, customers: data.customers });
        return;
      }
      const p = data.preview as Preview;
      setPreview(p);
      setTemplateId(p.template.id);
      // Seed typed-in fields with what was read, so Import sends them back.
      setPrompts({
        ...opts.prompts,
        ...(p.sheet.courierCompany ? { courierCompany: p.sheet.courierCompany } : {}),
      });
    } catch {
      setProblem({ code: "NETWORK", message: "Failed to connect to server" });
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!file || !preview) return;
    setBusy(true);
    try {
      const { res, data } = await send(file, "import", { templateId, prompts });
      if (!res.ok) {
        setProblem({ code: data.code, message: data.error, template: data.template });
        return;
      }
      reset();
      onImported(data.id);
    } catch {
      setProblem({ code: "NETWORK", message: "Failed to connect to server" });
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setFile(null);
    setPreview(null);
    setProblem(null);
    setPrompts({});
    setTemplateId(undefined);
  };

  const editTemplate = async (id: string) => {
    let editing: TemplateSummary | null = null;
    if (id !== "builtin") {
      const res = await fetch(`/api/import-templates/${id}`).catch(() => null);
      if (res?.ok) editing = await res.json();
    }
    setWizard({ editing });
  };

  const blocks = preview?.issues.filter((i) => i.level === "block") ?? [];
  const warnings = preview?.issues.filter((i) => i.level === "warning") ?? [];

  return (
    <div className="space-y-4">
      <input
        ref={input}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        id="courier-sheet-upload"
        onChange={(e) => {
          const picked = e.target.files?.[0];
          e.target.value = "";
          if (picked) void read(picked);
        }}
      />

      {!preview && (
        <div
          onClick={() => input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) void read(dropped);
          }}
          className={`bg-ink-card border-2 border-dashed rounded p-8 text-center cursor-pointer transition-colors ${
            over ? "border-ink-green bg-ink-green-dim" : "border-ink-border hover:border-ink-black/30"
          }`}
        >
          <p className="text-sm font-medium text-ink-black">
            {busy ? "Reading…" : "Drop a courier trip sheet here or click to browse"}
          </p>
          <p className="text-xs text-ink-muted mt-1">
            The Excel file from the Trip application — the sheet number is read from its name (cts-200189-p5.xlsx).
          </p>
        </div>
      )}

      {problem && (
        <div className="px-4 py-3 rounded border bg-ink-amber-dim border-ink-amber/40 space-y-2">
          <p className="text-sm text-ink-black font-medium">
            {problem.code === "DUPLICATE" ? "Already imported" : `Could not import ${file?.name ?? "the sheet"}`}
          </p>
          <p className="text-xs text-ink-muted font-mono break-words">{problem.message}</p>
          {problem.customers && problem.customers.length > 1 && (
            <p className="text-xs text-ink-black">Split the sheet so each customer has their own, then upload each.</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            {TEMPLATE_CODES.has(problem.code) && file && (
              <>
                <button type="button" className="act act-primary" onClick={() => setWizard({ editing: null })}>
                  Set up a template from this file
                </button>
                {problem.code === "MISSING_COLUMNS" && problem.template && problem.template.id !== "builtin" && (
                  <button type="button" className="act" onClick={() => editTemplate(problem.template!.id)}>
                    Edit “{problem.template.name}”
                  </button>
                )}
              </>
            )}
            {problem.code === "NEEDS_SHEET_NUMBER" && file && (
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void read(file, { templateId, prompts });
                }}
              >
                <label className="block">
                  <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">
                    Courier sheet number
                  </span>
                  <input
                    type="text"
                    value={prompts.courierSheetNo ?? ""}
                    onChange={(e) => setPrompts((p) => ({ ...p, courierSheetNo: e.target.value }))}
                    className="w-40 px-2 py-1 text-sm font-mono bg-white border border-ink-border rounded"
                    placeholder="e.g. 200189"
                  />
                </label>
                <button type="submit" className="act act-green" disabled={!prompts.courierSheetNo?.trim()}>
                  Read again
                </button>
              </form>
            )}
            <button type="button" className="act" onClick={reset}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {preview && file && (
        <div className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <div className="px-5 py-4 border-b border-ink-border flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="font-mono text-sm font-medium text-ink-black">
                Courier trip sheet {preview.sheet.courierSheetNo} · {preview.sheet.customerName}
              </h3>
              <p className="text-xs text-ink-muted mt-0.5">
                {file.name} · read with {preview.template.name}
              </p>
            </div>
            <CourierStatusBadge status={preview.status} />
          </div>

          <div className="px-5 py-4 space-y-4">
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Date</dt>
                <dd className="text-ink-black">{formatSheetDate(preview.sheet.sheetDate)}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">
                  {preview.sheet.waybills.length === 1 ? "Waybill" : "Waybills"}
                </dt>
                <dd className="text-ink-black font-mono break-words">{preview.sheet.waybills.join(", ")}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Parcels</dt>
                <dd className="text-ink-black">{preview.sheet.parcels ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Customer contact</dt>
                <dd className="text-ink-black break-words">
                  {preview.contact ? preview.contact.email || `${preview.contact.companyName} (no email)` : "None found"}
                </dd>
              </div>
            </dl>

            {preview.template.prompts.some((p) => p.key === "courierCompany") && (
              <label className="block max-w-xs">
                <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">
                  Courier company
                </span>
                <input
                  type="text"
                  value={prompts.courierCompany ?? ""}
                  onChange={(e) => setPrompts((p) => ({ ...p, courierCompany: e.target.value }))}
                  placeholder="e.g. MJV — or fill it in at signing"
                  className="w-full px-2 py-1.5 text-sm bg-white border border-ink-border rounded focus:outline-none focus:border-ink-green"
                />
              </label>
            )}

            {(blocks.length > 0 || warnings.length > 0) && (
              <ul className="space-y-1.5">
                {blocks.map((i, n) => (
                  <li key={`b${n}`} className="px-3 py-2 text-sm rounded bg-ink-red-dim text-ink-red border border-ink-red/20">
                    {i.message}
                  </li>
                ))}
                {warnings.map((i, n) => (
                  <li
                    key={`w${n}`}
                    className="px-3 py-2 text-sm rounded bg-ink-amber-dim border border-ink-amber/30"
                    style={{ color: "var(--tone-amber-fg)" }}
                  >
                    {i.message}
                  </li>
                ))}
              </ul>
            )}
            {blocks.length > 0 && (
              <p className="text-xs text-ink-muted">
                It can be imported now and fixed on the sheet — the courier cannot sign for it until then.
              </p>
            )}

            <div className="overflow-x-auto border border-ink-border rounded">
              <table className="w-full text-sm">
                <thead className="bg-ink-surface text-[11px] font-mono text-ink-muted uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2 text-left font-normal">Invoice</th>
                    <th className="px-3 py-2 text-left font-normal">Date</th>
                    <th className="px-3 py-2 text-left font-normal">Waybill</th>
                    <th className="px-3 py-2 text-left font-normal">PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.lines.map((l) => (
                    <tr key={l.lineNo} className="border-t border-ink-border">
                      <td className="px-3 py-2 font-mono">{l.invoiceNo}</td>
                      <td className="px-3 py-2 text-ink-muted">{l.invoiceDate ? formatSheetDate(l.invoiceDate) : "—"}</td>
                      <td className="px-3 py-2 font-mono text-ink-muted">{l.waybillNo}</td>
                      <td className="px-3 py-2">
                        {l.invoiceFile ? (
                          <span className="text-ink-green">Found</span>
                        ) : (
                          <span className="text-ink-red">No PDF</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-t border-ink-border bg-ink-surface/50">
            {preview.duplicateOf ? (
              <p className="text-sm text-ink-black flex-1">
                Sheet {preview.sheet.courierSheetNo} is already imported.{" "}
                <Link href={`/courier/${preview.duplicateOf.id}`} className="underline">
                  Open it
                </Link>
              </p>
            ) : (
              <span className="flex-1" />
            )}
            <button type="button" onClick={reset} disabled={busy} className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black">
              Cancel
            </button>
            <button
              type="button"
              onClick={doImport}
              disabled={busy || !!preview.duplicateOf}
              className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
                busy || preview.duplicateOf
                  ? "bg-ink-border text-ink-muted cursor-not-allowed"
                  : "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]"
              }`}
            >
              {busy ? "Importing…" : "Import sheet"}
            </button>
          </div>
        </div>
      )}

      {wizard && file && (
        <MappingWizard
          sheetType="COURIER_TRIP_SHEET"
          file={file}
          editing={wizard.editing}
          onClose={() => setWizard(null)}
          onSaved={(saved) => {
            setWizard(null);
            void read(file, { templateId: saved.id, prompts });
          }}
        />
      )}
    </div>
  );
}
