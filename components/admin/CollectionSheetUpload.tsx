"use client";

import { useRef, useState } from "react";

interface UploadRow {
  key: string;
  file: File;
  state: "uploading" | "done" | "conflict" | "error";
  text: string;
}

interface UploadResponse {
  error?: string;
  conflict?: boolean;
  filename?: string;
  collectionNo?: string;
  fromFilename?: boolean;
  attached?: { collectionNo: string; customerName: string; read: boolean }[];
}

/** What came of one file, in the office's words. */
function describe(data: UploadResponse): string {
  const attached = data.attached ?? [];
  if (attached.length > 0) {
    const first = attached[0];
    const notRead = attached.some((a) => !a.read) ? " It could not be read yet; check it on the trip card." : "";
    return `Saved as ${data.filename} and attached to collection ${first.collectionNo} (${first.customerName}).${notRead}`;
  }
  const from = data.fromFilename ? " The number came from the file name." : "";
  return `Saved as ${data.filename}. It is picked up when collection ${data.collectionNo} arrives on a trip sheet.${from}`;
}

/**
 * The Collections tab's upload. Returns the button and, on a row of its own in
 * the page's wrapping header, what came of each file. One request per PDF, one at
 * a time, so one bad file costs only itself.
 */
export default function CollectionSheetUpload({ onChanged }: { onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [busy, setBusy] = useState(false);

  const patch = (key: string, next: Partial<UploadRow>) =>
    setRows((all) => all.map((r) => (r.key === key ? { ...r, ...next } : r)));

  const send = async (key: string, file: File, overwrite: boolean) => {
    patch(key, { state: "uploading", text: "Uploading…" });
    const form = new FormData();
    form.append("file", file);
    if (overwrite) form.append("overwrite", "true");
    try {
      const res = await fetch("/api/collections/sheets", { method: "POST", body: form });
      const data: UploadResponse = await res.json().catch(() => ({ error: "That file could not be uploaded" }));
      if (res.ok) patch(key, { state: "done", text: describe(data) });
      else if (data.conflict) patch(key, { state: "conflict", text: data.error ?? "Already in the folder" });
      else patch(key, { state: "error", text: data.error ?? "That file could not be uploaded" });
    } catch {
      patch(key, { state: "error", text: "Failed to connect to server" });
    }
  };

  const upload = async (files: File[]) => {
    const added = files.map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}`,
      file,
      state: "uploading" as const,
      text: "Waiting…",
    }));
    setRows(added);
    setBusy(true);
    for (const row of added) await send(row.key, row.file, false);
    setBusy(false);
    onChanged();
  };

  const replace = async (row: UploadRow) => {
    setBusy(true);
    await send(row.key, row.file, true);
    setBusy(false);
    onChanged();
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="sr-only"
        aria-label="Collection sheet PDFs"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) void upload(files);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="px-4 py-2.5 font-mono text-sm font-medium rounded transition-all bg-ink-green text-white hover:bg-ink-green-hover disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Upload collection sheet"}
      </button>

      {rows.length > 0 && (
        <div className="basis-full bg-ink-card border border-ink-border rounded divide-y divide-ink-border">
          {rows.map((r) => (
            <div key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
              <span className="font-mono text-ink-black break-all">{r.file.name}</span>
              <span
                className={`flex-1 min-w-[12rem] break-words ${
                  r.state === "error" ? "text-ink-red" : r.state === "conflict" ? "text-[color:var(--tone-amber-fg)]" : "text-ink-muted"
                }`}
              >
                {r.text}
              </span>
              {r.state === "conflict" && (
                <button
                  type="button"
                  disabled={busy}
                  className="act act-amber"
                  title="Replacing a sheet changes what the driver is sent to collect"
                  onClick={() => void replace(r)}
                >
                  Replace it
                </button>
              )}
            </div>
          ))}
          {!busy && (
            <div className="px-4 py-1.5 text-right">
              <button type="button" className="text-[11px] text-ink-muted hover:text-ink-black underline" onClick={() => setRows([])}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
