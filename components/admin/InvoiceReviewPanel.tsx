"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DocChip, StatusBadge, type Tone } from "@/components/ui/Chips";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { MANUAL_LINE_LIMITS, readManualLines } from "@/lib/invoice-lines-input";

/**
 * One invoice's details and product lines, as Signex holds them, for the
 * office to check and correct (manual trip builder plan, session 6).
 *
 * - Shows the header (date, customer, Deliver to, Invoice to) and the lines
 *   read off the PDF, with whatever sent them to review highlighted.
 * - "Read lines" reads them now (POST …/lines) — on demand only, never on
 *   open unless `autoRead`: a scan costs a Claude call.
 * - Details and lines can be corrected, or typed in from scratch for a scan
 *   nobody could read or an invoice with no PDF. Typed lines are MANUAL:
 *   an ordinary read never touches them; "Re-read PDF" may, after asking.
 *
 * Quantities only — nothing priced is shown or stored. Mounted on the
 * invoice page; the trip builder (sessions 7–8) opens it for a picked invoice.
 */

export interface InvoiceLinesView {
  id: string;
  invoiceNo: string;
  pdfFilename: string | null;
  status: "OK" | "NEEDS_REVIEW" | "FAILED" | null;
  source: "TEXT" | "AI" | "MANUAL" | null;
  issues: { code: string; level: "review" | "warning"; message: string }[];
  error: string | null;
  attempts: number;
  readAt: string | null;
  reading: boolean;
  stale: boolean;
  header: {
    invoiceNoNormalized: string;
    isStub: boolean;
    customerName: string | null;
    deliverToName: string | null;
    billToName: string | null;
    invoiceDate: string | null;
    headerSource: string | null;
    headerError: string | null;
  };
  lines: { lineNo: number; itemCode: string | null; shortName: string | null; description: string; qty: number; uom: string | null }[];
}

const INPUT_CLASS =
  "w-full px-2.5 py-1.5 bg-ink-surface border border-ink-border rounded text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors";
const LABEL_CLASS = "block text-[11px] font-medium text-ink-muted uppercase tracking-wide mb-1";
/** A field the read could not vouch for. */
const FLAG_CLASS = "ring-1 ring-[color:var(--tone-amber-fg)]/50 bg-[color:var(--tone-amber-bg)]";

/** Issues that are about the lines table, not the invoice number. */
const LINE_ISSUES = new Set(["NO_LINES", "QTY_UNREAD", "TOTALS_UNCHECKED", "LINES_TOTAL"]);

const STATUS: Record<string, { tone: Tone; label: string }> = {
  OK: { tone: "green", label: "Lines checked" },
  NEEDS_REVIEW: { tone: "amber", label: "Needs review" },
  FAILED: { tone: "red", label: "Lines not read" },
};
const SOURCE_LABEL: Record<string, string> = {
  TEXT: "Read from the PDF",
  AI: "Read from a scan by AI",
  MANUAL: "Entered by hand",
};

const formatDay = (d: string | null) =>
  d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString("en-ZA", { day: "2-digit", month: "2-digit", year: "numeric" }) : null;
const formatQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString("en-ZA", { maximumFractionDigits: 3 }));

interface DraftLine {
  key: number;
  itemCode: string;
  shortName: string | null;
  description: string;
  qty: string;
  uom: string;
}

let draftKey = 0;
const blankLine = (): DraftLine => ({ key: ++draftKey, itemCode: "", shortName: null, description: "", qty: "", uom: "" });

export default function InvoiceReviewPanel({
  invoiceId,
  autoRead = false,
  onChange,
}: {
  invoiceId: string;
  /** Read the lines on open when they have never been read (the builder's pick). */
  autoRead?: boolean;
  /** Called with every state the panel loads or saves. */
  onChange?: (view: InvoiceLinesView) => void;
}) {
  const [view, setView] = useState<InvoiceLinesView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "read" | "lines" | "details">(null);
  const [notice, setNotice] = useState<{ tone: "green" | "amber" | "red"; text: string } | null>(null);
  const [confirmReread, setConfirmReread] = useState(false);

  // Editing the lines: a draft, and the readAt it was opened on (the save is conditional on it).
  const [draft, setDraft] = useState<DraftLine[] | null>(null);
  const [basedOn, setBasedOn] = useState<string | null>(null);
  const [linesError, setLinesError] = useState<string | null>(null);

  // Editing the details.
  const [details, setDetails] = useState<{ invoiceDate: string; customerName: string; deliverToName: string; billToName: string } | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const show = useCallback((v: InvoiceLinesView) => {
    setView(v);
    onChangeRef.current?.(v);
  }, []);

  const read = useCallback(
    async (force: boolean) => {
      setBusy("read");
      setNotice(null);
      try {
        const res = await fetch(`/api/invoice-records/${encodeURIComponent(invoiceId)}/lines`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        });
        const json = await res.json();
        if (!res.ok) {
          setNotice({ tone: "red", text: json.error || "The lines could not be read" });
          return;
        }
        show(json);
        const text: Record<string, [("green" | "amber" | "red"), string]> = {
          READ: json.status === "OK" ? ["green", "Lines read and checked."] : ["amber", "Lines read — check what is highlighted."],
          FAILED: ["red", `The PDF could not be read: ${json.error ?? "unknown error"}`],
          BUSY: ["amber", "Someone else is reading this invoice now. Check again in a moment."],
          GAVE_UP: ["red", "This PDF could not be read after three tries. Re-read it, or enter the lines by hand."],
          MANUAL: ["amber", "The lines were entered by hand meanwhile, so the PDF was not read."],
          NO_PDF: ["amber", "There is no PDF on file for this invoice. Enter the lines by hand."],
        };
        const t = text[json.outcome];
        if (t) setNotice({ tone: t[0], text: t[1] });
      } catch {
        setNotice({ tone: "red", text: "Network error — the lines were not read." });
      } finally {
        setBusy(null);
      }
    },
    [invoiceId, show]
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/invoice-records/${encodeURIComponent(invoiceId)}/lines`);
      const json = await res.json();
      if (!res.ok) {
        setLoadError(json.error || "Failed to load the invoice");
        return null;
      }
      setLoadError(null);
      show(json);
      return json as InvoiceLinesView;
    } catch {
      setLoadError("Network error");
      return null;
    }
  }, [invoiceId, show]);

  const autoReadDone = useRef(false);
  useEffect(() => {
    load().then((v) => {
      if (!v || !autoRead || autoReadDone.current) return;
      autoReadDone.current = true;
      if (v.status === null && v.pdfFilename && !v.reading) read(false);
    });
  }, [load, autoRead, read]);

  // ── Lines editor ──
  const openEditor = (from: InvoiceLinesView) => {
    const lines = from.lines;
    setDraft(
      lines.length > 0
        ? lines.map((l) => ({
            key: ++draftKey,
            itemCode: l.itemCode ?? "",
            shortName: l.shortName,
            description: l.description,
            qty: formatQty(l.qty).replace(/\s/g, ""),
            uom: l.uom ?? "",
          }))
        : [blankLine()]
    );
    setBasedOn(from.readAt);
    setLinesError(null);
    setNotice(null);
  };

  const checked = useMemo(() => (draft ? readManualLines(draft) : null), [draft]);

  const saveLines = async (lines: unknown[], since: string | null) => {
    setBusy("lines");
    setLinesError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/invoice-records/${encodeURIComponent(invoiceId)}/lines`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines, basedOn: since }),
      });
      const json = await res.json();
      if (res.status === 409 && json.code === "LINES_CHANGED") {
        // Show what is there now; the person decides again from that.
        show({ ...json, error: json.readError ?? null });
        setDraft(null);
        setNotice({ tone: "amber", text: json.error });
        return;
      }
      if (!res.ok) {
        setLinesError(json.error || "The lines were not saved");
        return;
      }
      show(json);
      setDraft(null);
      setNotice({ tone: "green", text: "Lines saved. A read of the PDF will not replace them unless you re-read it." });
    } catch {
      setLinesError("Network error — the lines were not saved");
    } finally {
      setBusy(null);
    }
  };

  // ── Details editor ──
  const saveDetails = async () => {
    if (!details || !view) return;
    setBusy("details");
    setDetailsError(null);
    try {
      const res = await fetch(`/api/invoice-records/${encodeURIComponent(invoiceId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invoiceDate: details.invoiceDate || null,
          customerName: details.customerName,
          deliverToName: details.deliverToName,
          billToName: details.billToName,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setDetailsError(json.error || "The details were not saved");
        return;
      }
      show({
        ...view,
        header: {
          ...view.header,
          invoiceDate: json.invoiceDate,
          customerName: json.customerName,
          deliverToName: json.deliverToName,
          billToName: json.billToName,
          headerSource: json.headerSource,
          headerError: null,
        },
      });
      setDetails(null);
    } catch {
      setDetailsError("Network error — the details were not saved");
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <div className="bg-ink-card border border-ink-border rounded p-4">
        <p className="text-sm font-mono text-ink-red">{loadError}</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="bg-ink-card border border-ink-border rounded p-4 flex items-center gap-2">
        <span className="w-4 h-4 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
        <span className="text-sm font-mono text-ink-muted">Loading the invoice…</span>
      </div>
    );
  }

  const { header } = view;
  const reviewIssues = view.issues.filter((i) => i.level === "review");
  const numberIssue = view.issues.find((i) => i.code === "INVOICE_NO_MISMATCH");
  const linesFlagged = view.status === "NEEDS_REVIEW" && view.issues.some((i) => LINE_ISSUES.has(i.code) && i.level === "review");
  const headerRead = header.headerSource !== null;
  const flagDate = headerRead ? !header.invoiceDate : !!header.headerError;
  const flagParty = headerRead && header.headerSource !== "MANUAL" && !header.deliverToName && !header.billToName;
  const canRead = !!view.pdfFilename;
  const status = view.status ? STATUS[view.status] : null;
  const working = busy !== null || view.reading;

  return (
    <div className="bg-ink-card border border-ink-border rounded">
      {/* Title row */}
      <div className="flex items-center gap-2 flex-wrap px-4 sm:px-5 pt-4">
        <h2 className="font-mono text-sm font-medium text-ink-black mr-1">Invoice details &amp; lines</h2>
        {status ? (
          <StatusBadge tone={status.tone} dot>
            {status.label}
          </StatusBadge>
        ) : (
          <StatusBadge tone="idle">Lines not read</StatusBadge>
        )}
        {view.source && <span className="text-[12px] font-mono text-ink-muted">{SOURCE_LABEL[view.source]}</span>}
        {view.stale && (
          <StatusBadge tone="amber" title="A different PDF is filed under this number now">
            Read from an older PDF
          </StatusBadge>
        )}
        {(busy === "read" || view.reading) && (
          <span className="flex items-center gap-1.5 text-[12px] font-mono text-ink-muted" aria-live="polite">
            <span className="w-3 h-3 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
            Reading the PDF…
          </span>
        )}
      </div>

      {/* What the read found */}
      {(view.issues.length > 0 || (view.error && view.status !== "OK" && view.source !== "MANUAL")) && (
        <ul className="mx-4 sm:mx-5 mt-3 space-y-1">
          {[...reviewIssues, ...view.issues.filter((i) => i.level === "warning")].map((i) => (
            <li
              key={i.code}
              className={`text-[12px] rounded px-2.5 py-1.5 ${i.level === "review" ? "tone-amber" : "bg-ink-surface text-ink-muted"}`}
            >
              {i.message}
            </li>
          ))}
          {view.error && view.status !== "OK" && view.source !== "MANUAL" && (
            <li className="text-[12px] rounded px-2.5 py-1.5 tone-red break-words">Last read failed: {view.error}</li>
          )}
        </ul>
      )}
      {view.error && view.source === "MANUAL" && (
        <p className="mx-4 sm:mx-5 mt-3 text-[12px] rounded px-2.5 py-1.5 bg-ink-surface text-ink-muted break-words">
          The last re-read failed ({view.error}), so the lines entered by hand were kept.
        </p>
      )}

      {/* Details */}
      <div className="px-4 sm:px-5 pt-4">
        {details ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor={`irp-date-${invoiceId}`} className={LABEL_CLASS}>Invoice date</label>
                <input
                  id={`irp-date-${invoiceId}`}
                  type="date"
                  value={details.invoiceDate}
                  onChange={(e) => setDetails({ ...details, invoiceDate: e.target.value })}
                  className={`${INPUT_CLASS} font-mono`}
                />
              </div>
              <div>
                <label htmlFor={`irp-customer-${invoiceId}`} className={LABEL_CLASS}>Customer</label>
                <input
                  id={`irp-customer-${invoiceId}`}
                  type="text"
                  maxLength={200}
                  value={details.customerName}
                  onChange={(e) => setDetails({ ...details, customerName: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor={`irp-deliver-${invoiceId}`} className={LABEL_CLASS}>Deliver to</label>
                <input
                  id={`irp-deliver-${invoiceId}`}
                  type="text"
                  maxLength={200}
                  value={details.deliverToName}
                  onChange={(e) => setDetails({ ...details, deliverToName: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor={`irp-bill-${invoiceId}`} className={LABEL_CLASS}>Invoice to</label>
                <input
                  id={`irp-bill-${invoiceId}`}
                  type="text"
                  maxLength={200}
                  value={details.billToName}
                  onChange={(e) => setDetails({ ...details, billToName: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <p className="text-[12px] text-ink-muted">
              A date or name entered here is never overwritten by a later read. The customer is the trip sheet&apos;s — a later
              sheet naming it differently replaces it.
            </p>
            {detailsError && <p className="text-xs text-ink-red">{detailsError}</p>}
            <div className="flex gap-2 justify-end">
              <button type="button" className="act" onClick={() => setDetails(null)} disabled={busy === "details"}>
                Cancel
              </button>
              <button type="button" className="act act-primary" onClick={saveDetails} disabled={busy === "details"}>
                {busy === "details" ? "Saving…" : "Save details"}
              </button>
            </div>
          </div>
        ) : (
          <dl className="grid grid-cols-2 sm:grid-cols-[auto_1fr_auto_1fr] gap-x-4 gap-y-2 text-sm">
            <Field label="Invoice no" flagged={!!numberIssue} title={numberIssue?.message}>
              <DocChip kind="INV" number={view.invoiceNo} tone="ref" />
            </Field>
            <Field label="Invoice date" flagged={flagDate}>
              <span className="font-mono">{formatDay(header.invoiceDate) ?? "—"}</span>
            </Field>
            <Field label="Customer">{header.customerName ?? "—"}</Field>
            <Field label="Deliver to" flagged={flagParty}>{header.deliverToName ?? "—"}</Field>
            <Field label="Invoice to" flagged={flagParty}>{header.billToName ?? "—"}</Field>
            <div className="col-span-2 sm:col-span-2 flex items-start justify-end">
              <button
                type="button"
                className="act"
                disabled={working || draft !== null}
                onClick={() => {
                  setDetailsError(null);
                  setDetails({
                    invoiceDate: header.invoiceDate ?? "",
                    customerName: header.customerName ?? "",
                    deliverToName: header.deliverToName ?? "",
                    billToName: header.billToName ?? "",
                  });
                }}
              >
                Edit details
              </button>
            </div>
          </dl>
        )}
      </div>

      {/* Lines */}
      <div className="px-4 sm:px-5 py-4">
        {draft ? (
          <LinesEditor
            draft={draft}
            setDraft={setDraft}
            checkError={checked && !checked.ok ? checked.error : null}
            saveError={linesError}
            saving={busy === "lines"}
            onCancel={() => setDraft(null)}
            onSave={() => checked?.ok && saveLines(checked.lines, basedOn)}
          />
        ) : (
          <>
            {view.lines.length > 0 ? (
              <div className={`border rounded overflow-hidden bg-white ${linesFlagged ? "border-[color:var(--tone-amber-fg)]/60" : "border-ink-border"}`}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] font-mono text-ink-muted uppercase tracking-wide border-b border-ink-border">
                      <th className="px-3 py-2 w-8">#</th>
                      <th className="px-3 py-2">Product</th>
                      <th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 hidden sm:table-cell">Unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.lines.map((l) => (
                      <tr key={l.lineNo} className="border-b border-ink-border last:border-0 align-top">
                        <td className="px-3 py-2 font-mono text-ink-muted text-[12px]">{l.lineNo}</td>
                        <td className="px-3 py-2 min-w-0">
                          {l.itemCode && <span className="font-mono text-[12px] text-ink-black mr-2">{l.itemCode}</span>}
                          <span className="text-ink-black break-words">{l.description}</span>
                          {l.shortName && l.shortName !== l.description && (
                            <span className="block text-[12px] text-ink-muted">{l.shortName}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-right whitespace-nowrap">
                          {formatQty(l.qty)}
                          <span className="sm:hidden text-ink-muted text-[11px]"> {l.uom ?? ""}</span>
                        </td>
                        <td className="px-3 py-2 font-mono text-[12px] text-ink-muted hidden sm:table-cell">{l.uom ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className={`text-sm rounded px-3 py-2.5 ${view.status ? FLAG_CLASS + " text-ink-black" : "bg-ink-surface text-ink-muted"}`}>
                {!canRead
                  ? "There is no PDF of this invoice on file, so there are no lines to read. Enter them by hand."
                  : view.status === null
                    ? "The product lines have not been read yet."
                    : "No product lines are stored for this invoice."}
              </p>
            )}

            {notice && (
              <p
                className={`mt-3 text-[12px] rounded px-2.5 py-1.5 break-words tone-${notice.tone}`}
                aria-live="polite"
              >
                {notice.text}
              </p>
            )}

            <div className="flex flex-wrap gap-2 justify-end mt-3">
              {canRead && view.status === null && (
                <button type="button" className="act act-primary" disabled={working} onClick={() => read(false)}>
                  Read lines
                </button>
              )}
              {canRead && view.status !== null && (
                <button
                  type="button"
                  className="act"
                  disabled={working}
                  title="Read the PDF again, even though it has been read"
                  onClick={() => (view.source === "MANUAL" ? setConfirmReread(true) : read(true))}
                >
                  Re-read PDF
                </button>
              )}
              {view.reading && (
                <button type="button" className="act" disabled={busy !== null} onClick={() => load()}>
                  Check again
                </button>
              )}
              {view.status === "NEEDS_REVIEW" && view.lines.length > 0 && (
                <button
                  type="button"
                  className="act act-green"
                  disabled={working || details !== null}
                  title="You have checked the lines against the PDF and they are right"
                  onClick={() => saveLines(view.lines, view.readAt)}
                >
                  Lines are right
                </button>
              )}
              <button
                type="button"
                className="act"
                disabled={working || details !== null}
                onClick={() => openEditor(view)}
              >
                {view.lines.length > 0 ? "Edit lines" : "Enter lines"}
              </button>
            </div>
          </>
        )}
      </div>

      {confirmReread && (
        <ConfirmDialog
          title="Replace the lines entered by hand?"
          confirmLabel="Re-read PDF"
          busyLabel="Reading…"
          busy={busy === "read"}
          onCancel={() => setConfirmReread(false)}
          onConfirm={async () => {
            await read(true);
            setConfirmReread(false);
          }}
        >
          <p>
            These lines were entered by hand. Reading the PDF again replaces them with what it reads. If the read fails, the
            lines entered by hand are kept.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function Field({ label, flagged = false, title, children }: { label: string; flagged?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide pt-1">{label}</dt>
      <dd className={`min-w-0 break-words rounded px-1.5 py-0.5 -mx-1.5 ${flagged ? FLAG_CLASS : ""}`} title={title}>
        {children}
        {flagged && <span className="sr-only"> (needs checking)</span>}
      </dd>
    </>
  );
}

function LinesEditor({
  draft,
  setDraft,
  checkError,
  saveError,
  saving,
  onCancel,
  onSave,
}: {
  draft: DraftLine[];
  setDraft: (d: DraftLine[]) => void;
  checkError: string | null;
  saveError: string | null;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const edit = (key: number, patch: Partial<DraftLine>) => setDraft(draft.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const remove = (key: number) => {
    const next = draft.filter((l) => l.key !== key);
    setDraft(next.length > 0 ? next : [blankLine()]);
  };

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-ink-muted">
        Quantities only. A row left blank is ignored. Saved lines are marked as entered by hand: reading the PDF will not
        replace them unless you re-read it.
      </p>
      <div className="hidden sm:grid grid-cols-[2rem_8rem_minmax(0,1fr)_5.5rem_5.5rem_2.25rem] gap-2 text-[11px] font-mono text-ink-muted uppercase tracking-wide px-0.5">
        <span>#</span>
        <span>Product no</span>
        <span>Description</span>
        <span className="text-right">Qty</span>
        <span>Unit</span>
        <span />
      </div>
      <ol className="space-y-2">
        {draft.map((l, i) => (
          <li
            key={l.key}
            className="grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)] sm:grid-cols-[2rem_8rem_minmax(0,1fr)_5.5rem_5.5rem_2.25rem] gap-2 items-center border-b border-ink-border sm:border-0 pb-2 sm:pb-0"
          >
            <span className="font-mono text-[12px] text-ink-muted row-span-3 sm:row-span-1 self-start pt-2">{i + 1}</span>
            <input
              aria-label={`Line ${i + 1} product no`}
              placeholder="Product no"
              value={l.itemCode}
              maxLength={MANUAL_LINE_LIMITS.itemCode}
              onChange={(e) => edit(l.key, { itemCode: e.target.value })}
              className={`${INPUT_CLASS} font-mono col-span-2 sm:col-span-1`}
            />
            <input
              aria-label={`Line ${i + 1} description`}
              placeholder="Description"
              value={l.description}
              maxLength={MANUAL_LINE_LIMITS.description}
              onChange={(e) => edit(l.key, { description: e.target.value })}
              className={`${INPUT_CLASS} col-span-2 sm:col-span-1`}
            />
            <input
              aria-label={`Line ${i + 1} quantity`}
              placeholder="Qty"
              inputMode="decimal"
              value={l.qty}
              onChange={(e) => edit(l.key, { qty: e.target.value })}
              className={`${INPUT_CLASS} font-mono text-right`}
            />
            <div className="flex gap-2 sm:contents">
              <input
                aria-label={`Line ${i + 1} unit`}
                placeholder="Unit"
                value={l.uom}
                maxLength={MANUAL_LINE_LIMITS.uom}
                onChange={(e) => edit(l.key, { uom: e.target.value })}
                className={`${INPUT_CLASS} font-mono`}
              />
              <button
                type="button"
                className="act act-icon act-danger shrink-0"
                aria-label={`Remove line ${i + 1}`}
                title="Remove this line"
                onClick={() => remove(l.key)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="act" onClick={() => setDraft([...draft, blankLine()])}>
          + Add line
        </button>
        <p className="text-[12px] flex-1 min-w-[10rem] text-right" aria-live="polite">
          {saveError ? (
            <span className="text-ink-red">{saveError}</span>
          ) : checkError ? (
            <span className="text-ink-muted">{checkError}</span>
          ) : null}
        </p>
      </div>
      <div className="flex gap-2 justify-end">
        <button type="button" className="act" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="act act-primary" onClick={onSave} disabled={saving || !!checkError}>
          {saving ? "Saving…" : "Save lines"}
        </button>
      </div>
    </div>
  );
}
