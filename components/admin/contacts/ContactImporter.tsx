"use client";

/**
 * ContactImporter.tsx
 * Two-step drag-and-drop file importer for contacts.
 */

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";

interface ParsedContact {
  companyName: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  altPhone?: string;
  address?: string;
  notes?: string;
}

type ImportState = "idle" | "uploading" | "preview" | "confirming" | "done" | "error";

const ACCEPTED = {
  "text/csv": [".csv"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-excel": [".xls"],
  "application/pdf": [".pdf"],
};

export function ContactImporter() {
  const [state, setState] = useState<ImportState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [preview, setPreview] = useState<ParsedContact[]>([]);
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [result, setResult] = useState<{ saved: number; skipped: number } | null>(null);

  const isPDF = currentFile
    ? currentFile.type === "application/pdf" || currentFile.name.toLowerCase().endsWith(".pdf")
    : false;

  const onDrop = useCallback(async (accepted: File[]) => {
    const file = accepted[0];
    if (!file) return;
    setCurrentFile(file);
    setState("uploading");
    setErrorMsg("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("confirm", "false");
      const res = await fetch("/api/contacts/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Parse failed");
      setPreview(data.preview ?? []);
      setState("preview");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Upload failed");
      setState("error");
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: ACCEPTED,
    maxSize: 10 * 1024 * 1024,
    multiple: false,
    disabled: state !== "idle" && state !== "error",
  });

  async function confirmImport() {
    if (!currentFile) return;
    setState("confirming");
    try {
      const fd = new FormData();
      fd.append("file", currentFile);
      fd.append("confirm", "true");
      const res = await fetch("/api/contacts/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setResult({ saved: data.saved, skipped: data.skipped });
      setState("done");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Import failed");
      setState("error");
    }
  }

  function reset() {
    setState("idle");
    setPreview([]);
    setCurrentFile(null);
    setResult(null);
    setErrorMsg("");
  }

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
      <div className="px-5 py-4 border-b border-zinc-100">
        <h2 className="text-sm font-semibold font-mono text-zinc-900">Import contacts</h2>
        <p className="text-xs text-zinc-500 mt-0.5">Upload a spreadsheet (.csv, .xlsx) or PDF — PDFs are parsed by AI.</p>
      </div>
      <div className="p-5">

        {/* IDLE / ERROR */}
        {(state === "idle" || state === "error") && (
          <>
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                isDragActive ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 hover:border-zinc-400 hover:bg-zinc-50"
              }`}
            >
              <input {...getInputProps()} />
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-zinc-100 flex items-center justify-center">
                  <svg className="w-6 h-6 text-zinc-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-700">
                    {isDragActive ? "Drop to upload" : "Drag & drop or click to upload"}
                  </p>
                  <p className="text-xs text-zinc-400 mt-1">CSV, XLSX, XLS, PDF · max 10 MB</p>
                </div>
              </div>
            </div>
            {state === "error" && (
              <p className="mt-3 text-sm text-red-600 bg-red-50 px-4 py-2.5 rounded-lg">{errorMsg}</p>
            )}
          </>
        )}

        {/* UPLOADING */}
        {state === "uploading" && (
          <div className="flex flex-col items-center gap-3 py-10">
            <div className="w-8 h-8 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin" />
            <p className="text-sm text-zinc-600">{isPDF ? "Saving with AI…" : "Parsing spreadsheet…"}</p>
          </div>
        )}

        {/* PREVIEW */}
        {state === "preview" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-zinc-900">
                  {preview.length} contact{preview.length !== 1 ? "s" : ""} found
                </span>
                {currentFile && (
                  <span className={`text-xs px-2.5 py-1 rounded-full font-medium border ${
                    isPDF ? "bg-amber-100 text-amber-800 border-amber-200" : "bg-blue-100 text-blue-800 border-blue-200"
                  }`}>
                    {isPDF ? "PDF — AI extraction" : "Spreadsheet"}
                  </span>
                )}
              </div>
              <button onClick={reset} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">Cancel</button>
            </div>

            <div className="rounded-lg border border-zinc-200 overflow-hidden max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-zinc-50 sticky top-0">
                  <tr>
                    {["Company", "Contact", "Email", "Phone"].map((h) => (
                      <th key={h} className="text-left px-3 py-2 font-medium text-zinc-500 border-b border-zinc-200">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {preview.map((row, i) => (
                    <tr key={i} className="hover:bg-zinc-50">
                      <td className="px-3 py-2 font-medium text-zinc-800">{row.companyName}</td>
                      <td className="px-3 py-2 text-zinc-600">{row.contactPerson || "—"}</td>
                      <td className="px-3 py-2 text-zinc-600">{row.email || "—"}</td>
                      <td className="px-3 py-2 text-zinc-600">{row.phone || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-3">
              <button onClick={reset} className="flex-1 py-2 text-sm border border-zinc-200 rounded-lg text-zinc-600 hover:bg-zinc-50 transition-colors font-medium">Cancel</button>
              <button onClick={confirmImport} className="flex-1 py-2 text-sm bg-zinc-900 text-white rounded-lg hover:bg-zinc-800 transition-colors font-medium font-mono">
                Import {preview.length} contact{preview.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* CONFIRMING */}
        {state === "confirming" && (
          <div className="flex flex-col items-center gap-3 py-10">
            <div className="w-8 h-8 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin" />
            <p className="text-sm text-zinc-600">Importing contacts…</p>
          </div>
        )}

        {/* DONE */}
        {state === "done" && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-emerald-800">{result.saved} contact{result.saved !== 1 ? "s" : ""} imported</p>
                {result.skipped > 0 && (
                  <p className="text-xs text-emerald-700 mt-0.5">{result.skipped} duplicate{result.skipped !== 1 ? "s" : ""} skipped</p>
                )}
              </div>
            </div>
            <button onClick={reset} className="w-full py-2 text-sm border border-zinc-200 rounded-lg text-zinc-600 hover:bg-zinc-50 transition-colors font-medium">
              Import another file
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
