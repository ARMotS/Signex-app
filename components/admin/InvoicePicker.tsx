"use client";

/**
 * Choose invoices from the branch's invoice folder — for the manual trip
 * builder and a manual courier dispatch. The list is `GET /api/invoices/picker`
 * (lib/invoice-picker.ts): one page at a time, searched and dated on the
 * server, each invoice with where it is allocated.
 *
 *   • By default only invoices that can be picked are listed; "Show allocated"
 *     lists the rest greyed, naming the run, courier sheet or signature that
 *     holds each.
 *   • A pick is keyed by the invoice number, so two copies of one invoice in
 *     the folder can never both be picked — choosing one replaces the other.
 *   • PDFs not in the folder yet can be uploaded from here. Each is saved
 *     under its invoice number (matching is by filename: a scan saved under
 *     its camera name would be the wrong invoice or none), into the same
 *     folder the Excel route matches against, then picked if it can be.
 *
 * `InvoicePicker` is the panel; `InvoicePickerDialog` opens it full screen on
 * a phone and as a dialog on a desk, portalled to <body> (a transformed
 * ancestor would otherwise pin a fixed dialog inside its card).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Pager from "@/components/ui/Pager";
import { DocChip, StatusBadge, type Tone } from "@/components/ui/Chips";
import type { PickerInvoice, PickerState } from "@/lib/invoice-picker";
import type { InvoiceIndexStatus } from "@/lib/invoice-index";

/** What a consumer receives for each picked invoice. */
export interface PickedInvoice {
  /** The normalized invoice number — unique within a pick. */
  key: string;
  invoiceNo: string;
  filename: string;
  recordId: string | null;
  invoiceDate: string | null;
  customerName: string | null;
}

interface PickerResponse {
  items: PickerInvoice[];
  total: number;
  page: number;
  size: number;
  counts: { available: number; all: number };
  named: PickerInvoice[];
  folder: string;
  source: "onedrive" | "local";
  index: InvoiceIndexStatus;
}

const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 250;

const INPUT_CLASS =
  "w-full px-3 py-2 bg-ink-surface border border-ink-border rounded text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors";
const LABEL_CLASS = "block text-[11px] font-medium text-ink-muted uppercase tracking-wide mb-1";

const STATE_TONE: Record<PickerState, Tone> = {
  AVAILABLE: "idle",
  ON_RUN: "amber",
  ON_COURIER_SHEET: "blue",
  WITH_COURIER: "violet",
  SIGNED: "green",
  NO_NUMBER: "red",
};

export function toPicked(r: PickerInvoice): PickedInvoice {
  return {
    key: r.key,
    invoiceNo: r.invoiceNo,
    filename: r.filename,
    recordId: r.recordId,
    invoiceDate: r.invoiceDate,
    customerName: r.customerName,
  };
}

/** DD/MM/YYYY, as the trip sheets write it. */
function formatDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** A file timestamp on the viewer's clock, as DD/MM/YYYY. */
function formatFileDay(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(t.getDate())}/${pad(t.getMonth() + 1)}/${t.getFullYear()}`;
}

/** What holds an invoice that cannot be picked, in words. */
function heldBy(r: PickerInvoice): string | null {
  if (r.state === "NO_NUMBER") return "Rename the file to its invoice number to use it";
  if (r.run) return [r.run.tripName, r.run.driverName].filter(Boolean).join(" · ");
  if (r.courierSheet) return `Courier sheet ${r.courierSheet.courierSheetNo}`;
  return null;
}

// ─── Upload ───────────────────────────────────────────────────────────────

interface StagedFile {
  id: string;
  file: File;
  /** The number the file is saved under — editable; the filename's stem to start with. */
  invoiceNumber: string;
  state: "staged" | "uploading" | "saved" | "exists" | "failed";
  message?: string;
  savedAs?: string;
}

const stemOf = (name: string) => name.replace(/\.pdf$/i, "").trim();

/**
 * Choose PDFs, confirm the number each is saved under, upload one request
 * each (POST /api/invoices/upload). Sequential: a name clash on one file must
 * not read as a failure of the batch.
 */
function UploadPanel({
  onStart,
  onSaved,
  onClose,
}: {
  /** An upload is starting — the last one's note no longer applies. */
  onStart: () => void;
  /** Filenames just saved into the folder. */
  onSaved: (filenames: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/invoices/upload")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.destination && setDestination(d.destination))
      .catch(() => {});
  }, []);

  const add = (files: FileList | null) => {
    if (!files) return;
    const next = [...files]
      .filter((f) => f.name.toLowerCase().endsWith(".pdf"))
      .map((file, i) => ({
        id: `${Date.now()}-${i}-${file.name}`,
        file,
        invoiceNumber: stemOf(file.name),
        state: "staged" as const,
      }));
    const skipped = files.length - next.length;
    setStaged((s) => [
      // What went in, and the "not a PDF" notes, make way for the new choice.
      ...s.filter((x) => x.state !== "saved" && x.state !== "exists" && x.file.size > 0),
      ...next,
      ...(skipped > 0
        ? [
            {
              id: `skip-${Date.now()}`,
              file: new File([], `${skipped} file${skipped === 1 ? "" : "s"} skipped`),
              invoiceNumber: "",
              state: "failed" as const,
              message: "Only PDF files can be uploaded as invoices",
            },
          ]
        : []),
    ]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const pending = staged.filter((s) => s.state === "staged" || s.state === "failed").filter((s) => s.file.size > 0);
  const ready = pending.length > 0 && pending.every((s) => s.invoiceNumber.trim());

  const upload = async () => {
    setBusy(true);
    onStart();
    const saved: string[] = [];
    for (const s of pending) {
      setStaged((all) => all.map((x) => (x.id === s.id ? { ...x, state: "uploading", message: undefined } : x)));
      let patch: Partial<StagedFile>;
      try {
        const form = new FormData();
        form.append("file", s.file);
        form.append("invoiceNumber", s.invoiceNumber.trim());
        const res = await fetch("/api/invoices/upload", { method: "POST", body: form });
        const json = await res.json().catch(() => ({}));
        if (res.ok) {
          saved.push(json.filename);
          patch = { state: "saved", savedAs: json.filename, message: `Saved as ${json.filename}` };
        } else if (res.status === 409) {
          // Never replaced from here: the PDF behind an invoice number is what
          // a driver presents at the door. The Invoices page can replace it.
          patch = {
            state: "exists",
            message: `${json.filename ?? "A file with that name"} is already in the folder — search for it above`,
          };
        } else {
          patch = { state: "failed", message: json.error || "Upload failed" };
        }
      } catch {
        patch = { state: "failed", message: "Upload failed — check the connection and try again" };
      }
      setStaged((all) => all.map((x) => (x.id === s.id ? { ...x, ...patch } : x)));
    }
    if (saved.length) await onSaved(saved);
    setBusy(false);
  };

  return (
    <div className="border border-ink-border rounded bg-ink-surface/40 p-3 sm:p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-ink-black">Upload invoice PDFs</p>
          <p className="text-xs text-ink-muted mt-0.5">
            Each is saved under its invoice number{destination ? ` to ${destination}` : ""}, so a trip sheet naming that
            number finds it too.
          </p>
        </div>
        <button type="button" className="act act-icon" onClick={onClose} disabled={busy} aria-label="Close upload">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {staged.length > 0 && (
        <ul className="space-y-2">
          {staged.map((s) => (
            <li key={s.id} className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_11rem] gap-x-3 gap-y-1 items-center">
              <div className="min-w-0">
                <p className="text-sm text-ink-black truncate" title={s.file.name}>
                  {s.file.name}
                </p>
                {s.message && (
                  <p
                    className={`text-xs mt-0.5 break-words ${
                      s.state === "saved" ? "text-ink-green" : s.state === "exists" ? "text-ink-muted" : "text-ink-red"
                    }`}
                  >
                    {s.message}
                  </p>
                )}
              </div>
              {s.file.size > 0 && (s.state === "staged" || s.state === "failed" || s.state === "uploading") && (
                <label className="block">
                  <span className="block text-[10px] font-medium text-ink-muted uppercase tracking-wide mb-0.5">
                    Save as invoice no
                  </span>
                  <input
                    type="text"
                    value={s.invoiceNumber}
                    disabled={busy}
                    maxLength={60}
                    onChange={(e) =>
                      setStaged((all) => all.map((x) => (x.id === s.id ? { ...x, invoiceNumber: e.target.value } : x)))
                    }
                    placeholder="Invoice no"
                    aria-label={`Invoice number for ${s.file.name}`}
                    className={`${INPUT_CLASS} font-mono`}
                  />
                </label>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="sr-only"
          id="invoice-picker-upload"
          onChange={(e) => add(e.target.files)}
          disabled={busy}
        />
        <label htmlFor="invoice-picker-upload" className={`act ${busy ? "opacity-50 pointer-events-none" : "cursor-pointer"}`}>
          Choose PDFs…
        </label>
        {pending.length > 0 && (
          <button type="button" className="act act-primary" onClick={upload} disabled={busy || !ready}>
            {busy ? "Uploading…" : `Upload ${pending.length}`}
          </button>
        )}
        {pending.length > 0 && !ready && !busy && (
          <span className="text-xs text-ink-muted">Every file needs its invoice number.</span>
        )}
      </div>
    </div>
  );
}

// ─── The panel ────────────────────────────────────────────────────────────

export function InvoicePicker({
  value,
  onChange,
  disabledReason,
}: {
  value: PickedInvoice[];
  onChange: (next: PickedInvoice[]) => void;
  /** A consumer's own rule on top of availability (a courier dispatch: one customer). */
  disabledReason?: (row: PickerInvoice, picked: PickedInvoice[]) => string | null;
}) {
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(PAGE_SIZE);
  const [data, setData] = useState<PickerResponse | null>(null);
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const picked = useMemo(() => new Map(value.map((v) => [v.key, v])), [value]);

  // The search box answers as typed; the request waits for a pause.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(query.trim());
      setPage(1);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [query]);

  const paramsFor = useCallback(
    (extra?: { names?: string[]; page?: number }) => {
      const p = new URLSearchParams();
      if (q) p.set("q", q);
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      if (showAll) p.set("show", "all");
      p.set("page", String(extra?.page ?? page));
      p.set("size", String(size));
      p.set("tzOffset", String(new Date().getTimezoneOffset()));
      for (const n of extra?.names ?? []) p.append("name", n);
      return p;
    },
    [q, from, to, showAll, page, size]
  );

  // Loading = the list shown does not answer the request in force. Derived,
  // so the effect below only ever sets state from the request's callbacks.
  const requestKey = `${paramsFor()}#${reloadTick}`;
  const loading = answeredKey !== requestKey;

  useEffect(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    fetch(`/api/invoices/picker?${requestKey.slice(0, requestKey.lastIndexOf("#"))}`, { signal: ctrl.signal })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(
            json.code === "FOLDER_UNREADABLE"
              ? "The invoice folder could not be read just now. Try again in a moment."
              : json.error || "Could not load invoices"
          );
          return;
        }
        setError(null);
        setData(json);
        if (json.page !== page) setPage(json.page);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") setError("Failed to connect to server");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setAnsweredKey(requestKey);
      });
    return () => ctrl.abort();
    // `page` is in the key; it is read here only to follow the server's clamp.
  }, [requestKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = data?.items ?? [];

  const reasonFor = (r: PickerInvoice): string | null => {
    if (!r.selectable) return null; // its state already says why
    return disabledReason?.(r, value) ?? null;
  };

  const toggle = (r: PickerInvoice) => {
    if (!r.selectable || reasonFor(r)) return;
    const current = picked.get(r.key);
    if (current?.filename === r.filename) {
      onChange(value.filter((v) => v.key !== r.key));
    } else {
      // A second copy of the same invoice replaces the first, in place.
      onChange(current ? value.map((v) => (v.key === r.key ? toPicked(r) : v)) : [...value, toPicked(r)]);
    }
  };

  /** After an upload: pick what was saved, where it can be picked. */
  const afterUpload = async (filenames: string[]) => {
    try {
      const res = await fetch(`/api/invoices/picker?${paramsFor({ names: filenames, page: 1 })}`);
      const json: PickerResponse = await res.json();
      if (!res.ok) throw new Error();
      const named = json.named;
      const add = named.filter((r) => r.selectable && !reasonFor(r) && !picked.has(r.key));
      if (add.length) onChange([...value, ...add.map(toPicked)]);
      const notPicked = named.filter((r) => !add.includes(r) && !picked.has(r.key));
      setUploadNote(
        [
          add.length ? `${add.length} uploaded invoice${add.length === 1 ? "" : "s"} picked.` : null,
          ...notPicked.map((r) => `${r.invoiceNo}: ${r.stateLabel}${heldBy(r) ? ` (${heldBy(r)})` : ""}.`),
        ]
          .filter(Boolean)
          .join(" ") || null
      );
    } catch {
      setUploadNote("Uploaded. Search for the new invoices to pick them.");
    }
    setPage(1);
    setReloadTick((t) => t + 1);
  };

  const anyFilter = !!(q || from || to);

  return (
    <div className="space-y-3">
      {/* Search, dates, show-allocated, upload */}
      <div className="grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_9.5rem_9.5rem] gap-2 items-end">
        <div className="col-span-2 sm:col-span-1">
          <label htmlFor="invoice-picker-q" className={LABEL_CLASS}>
            Search
          </label>
          <input
            id="invoice-picker-q"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Invoice no or customer"
            autoComplete="off"
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="invoice-picker-from" className={LABEL_CLASS}>
            From
          </label>
          <input
            id="invoice-picker-from"
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="invoice-picker-to" className={LABEL_CLASS}>
            To
          </label>
          <input
            id="invoice-picker-to"
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-ink-black cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => {
              setShowAll(e.target.checked);
              setPage(1);
            }}
            className="w-4 h-4 rounded border-ink-border accent-[#00C07F]"
          />
          Show allocated
        </label>
        <p className="text-xs font-mono text-ink-muted flex-1 min-w-[10rem]" aria-live="polite">
          {data
            ? `${data.counts.available} available${
                data.counts.all !== data.counts.available ? ` · ${data.counts.all - data.counts.available} not available` : ""
              }${anyFilter ? " for this search" : ""}`
            : ""}
        </p>
        {!uploadOpen && (
          <button type="button" className="act" onClick={() => setUploadOpen(true)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Upload PDFs
          </button>
        )}
      </div>

      {uploadOpen && <UploadPanel onStart={() => setUploadNote(null)} onSaved={afterUpload} onClose={() => setUploadOpen(false)} />}
      {uploadNote && (
        <p className="text-xs text-ink-muted bg-ink-surface border border-ink-border rounded px-3 py-2" role="status">
          {uploadNote}
        </p>
      )}
      {data?.index.state === "building" && (
        <p className="text-xs text-ink-muted">Reading the invoice folder directly while its index is being built — this can take a few seconds.</p>
      )}

      {/* The list */}
      <div className="border border-ink-border rounded overflow-hidden">
        {error ? (
          <div className="px-4 py-6 text-center space-y-3">
            <p className="text-sm text-ink-red">{error}</p>
            <button type="button" className="act" onClick={() => setReloadTick((t) => t + 1)}>
              Try again
            </button>
          </div>
        ) : !data && loading ? (
          <p className="px-4 py-8 text-center text-sm text-ink-muted">Loading invoices…</p>
        ) : rows.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-ink-black">
              {anyFilter ? "No invoices match this search." : showAll ? "The invoice folder is empty." : "No invoices are available."}
            </p>
            <p className="text-xs text-ink-muted mt-1">
              {!showAll && data && data.counts.all > 0
                ? "Every match is already allocated — tick Show allocated to see where."
                : "Upload the PDFs, or check the invoice folder in Settings."}
            </p>
          </div>
        ) : (
          <ul className={`divide-y divide-ink-border transition-opacity ${loading ? "opacity-60" : ""}`}>
            {rows.map((r) => {
              const reason = reasonFor(r);
              const enabled = r.selectable && !reason;
              const checked = picked.get(r.key)?.filename === r.filename;
              const otherCopy = !checked && picked.has(r.key);
              const holder = heldBy(r);
              return (
                <li key={r.filename}>
                  <label
                    className={`grid grid-cols-[1.25rem_minmax(0,1fr)] sm:grid-cols-[1.25rem_minmax(0,9rem)_minmax(0,1fr)_6rem] gap-x-3 gap-y-1 px-3 sm:px-4 py-3 items-start sm:items-center ${
                      enabled ? "cursor-pointer hover:bg-ink-surface/50" : "cursor-not-allowed bg-ink-surface/40"
                    } ${checked ? "bg-[#E9F8F1]" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!enabled}
                      onChange={() => toggle(r)}
                      aria-label={`Pick invoice ${r.invoiceNo}`}
                      className="w-4 h-4 mt-0.5 sm:mt-0 rounded border-ink-border accent-[#00C07F] disabled:opacity-40"
                    />
                    <div className={`min-w-0 ${enabled ? "" : "opacity-70"}`}>
                      <DocChip kind="INV" number={r.invoiceNo} tone={checked ? "green" : "idle"} />
                      {r.duplicate && (
                        <p className="text-[11px] text-ink-muted mt-1" title={r.filename}>
                          {otherCopy ? "Another copy is picked" : "One of two copies"}
                        </p>
                      )}
                    </div>
                    <div className={`min-w-0 col-start-2 sm:col-start-auto ${enabled ? "" : "opacity-70"}`}>
                      <p className="text-sm text-ink-black truncate">{r.customerName ?? <span className="text-ink-muted">Customer not read yet</span>}</p>
                      {(!r.selectable || reason) && (
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          {!r.selectable && <StatusBadge tone={STATE_TONE[r.state]}>{r.stateLabel}</StatusBadge>}
                          {(reason ?? holder) && <span className="text-xs text-ink-muted break-words">{reason ?? holder}</span>}
                        </div>
                      )}
                    </div>
                    <div className={`col-start-2 sm:col-start-auto text-xs font-mono sm:text-right ${enabled ? "text-ink-black" : "text-ink-muted"}`}>
                      {r.invoiceDate ? (
                        formatDay(r.invoiceDate)
                      ) : (
                        <span className="text-ink-muted" title="The file's date — the invoice's own date has not been read yet">
                          {formatFileDay(r.fileDate)}*
                        </span>
                      )}
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {data && !error && (
          <Pager
            page={data.page}
            pageSize={data.size}
            total={data.total}
            onPage={setPage}
            onPageSize={(s) => {
              setSize(s);
              setPage(1);
            }}
            disabled={loading}
          />
        )}
      </div>
      {rows.some((r) => !r.invoiceDate) && (
        <p className="text-[11px] text-ink-muted">* File date — the invoice&apos;s own date is read from the PDF shortly after it arrives.</p>
      )}
    </div>
  );
}

// ─── The dialog ───────────────────────────────────────────────────────────

export default function InvoicePickerDialog({
  title = "Add invoices",
  subtitle,
  confirmLabel = (n: number) => `Add ${n} invoice${n === 1 ? "" : "s"}`,
  initial = [],
  disabledReason,
  onCancel,
  onConfirm,
}: {
  title?: string;
  subtitle?: string;
  confirmLabel?: (count: number) => string;
  /** Already picked (reopening the picker keeps them). */
  initial?: PickedInvoice[];
  disabledReason?: (row: PickerInvoice, picked: PickedInvoice[]) => string | null;
  onCancel: () => void;
  onConfirm: (picked: PickedInvoice[]) => void;
}) {
  const [picked, setPicked] = useState<PickedInvoice[]>(initial);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Only in the browser — and never during hydration, so a page that opens
  // the picker on its first render does not mismatch the server's HTML.
  if (!mounted) return null;
  return createPortal(
    // Above the phone's bottom nav (z-50), which would hide the Add button.
    <div className="fixed inset-0 z-[60] flex bg-black/50 animate-fade-in md:items-center md:justify-center md:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-white w-full h-full flex flex-col overflow-hidden shadow-xl md:h-auto md:max-h-[94vh] md:max-w-4xl md:rounded-lg"
      >
        <div className="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-ink-border">
          <div className="flex-1 min-w-0">
            <h3 className="font-mono text-sm font-medium text-ink-black">{title}</h3>
            {subtitle && <p className="text-xs text-ink-muted mt-0.5 truncate">{subtitle}</p>}
          </div>
          <button type="button" className="act act-icon" onClick={onCancel} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
          <InvoicePicker value={picked} onChange={setPicked} disabledReason={disabledReason} />
        </div>

        <div className="border-t border-ink-border bg-ink-surface/50 px-4 sm:px-6 py-3 space-y-2">
          {picked.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto" aria-label="Picked invoices">
              {picked.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 group"
                    onClick={() => setPicked((all) => all.filter((x) => x.key !== p.key))}
                    aria-label={`Remove invoice ${p.invoiceNo}`}
                    title="Remove"
                  >
                    <DocChip kind="INV" number={p.invoiceNo} tone="green" />
                    <span className="text-ink-muted group-hover:text-ink-red text-sm leading-none" aria-hidden="true">
                      ×
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <p className="text-xs font-mono text-ink-muted flex-1">{picked.length ? `${picked.length} picked` : "Nothing picked yet"}</p>
            <button type="button" className="act" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="act act-primary" disabled={picked.length === 0} onClick={() => onConfirm(picked)}>
              {confirmLabel(picked.length)}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
