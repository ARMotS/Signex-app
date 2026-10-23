"use client";

/**
 * Collect & Sign: the courier driver signs for every invoice on the sheet at
 * once, on the office's tablet, phone or PC (operated by the logged-in
 * dispatcher — courier drivers have no account). Full screen on a phone or
 * tablet, a dialog on a PC. See lib/courier-collect.ts.
 *
 * The stamp preview is lib/courier-stamp-text.ts — the same code that words
 * the stamp on each invoice — so what is read here is what is printed.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import SignaturePad, { type SignaturePadHandle } from "@/components/SignaturePad";
import PdfViewer from "@/components/PdfViewer";
import { courierStampLines, formatStampTime } from "@/lib/courier-stamp-text";
import { formatSheetDate } from "./CourierStatusBadge";

export interface CollectSheet {
  id: string;
  courierSheetNo: string;
  customerName: string;
  customerEmail: string | null;
  courierCompany: string | null;
  parcels: number | null;
  waybills: string[];
  invoices: { id: string; invoiceNo: string; invoiceDate: string | null; invoiceFile: string | null; waybillNo: string }[];
}

const field =
  "w-full px-3 py-2 text-sm bg-white border border-ink-border rounded focus:outline-none focus:border-ink-green disabled:bg-ink-surface disabled:text-ink-muted";

export default function CollectAndSign({
  sheet,
  signer,
  onClose,
  onDone,
}: {
  sheet: CollectSheet;
  signer: { dispatcherName: string; dispatchCompany: string };
  onClose: () => void;
  /** Recorded. `filingProblem` when some signed copies still need filing. */
  onDone: (result: { filingProblem: string | null }) => void;
}) {
  const pad = useRef<SignaturePadHandle>(null);
  const [dispatcherName, setDispatcherName] = useState(signer.dispatcherName);
  const [courierDriverName, setCourierDriverName] = useState("");
  const [courierCompany, setCourierCompany] = useState(sheet.courierCompany ?? "");
  const [checked, setChecked] = useState(false);
  const [signed, setSigned] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ file: string; invoiceNo: string } | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [portrait, setPortrait] = useState(false);

  // The time shown ticks; the time recorded is the server's, at submit.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    const fit = () => setPortrait(window.innerWidth < 640 && window.innerHeight > window.innerWidth);
    fit();
    window.addEventListener("resize", fit);
    return () => {
      clearInterval(t);
      window.removeEventListener("resize", fit);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || submitting) return;
      if (viewing) setViewing(null);
      else if (confirming) setConfirming(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, onClose, submitting, viewing]);

  const count = sheet.invoices.length;
  const parcels = sheet.parcels ?? 0;
  const ready =
    checked && dispatcherName.trim() !== "" && courierDriverName.trim() !== "" && courierCompany.trim() !== "" && signed;
  const missing = [
    !checked && "tick the parcel check",
    !courierDriverName.trim() && "the courier driver's name",
    !courierCompany.trim() && "the courier company",
    !dispatcherName.trim() && "the dispatcher's name",
    !signed && "the courier driver's signature",
  ].filter(Boolean) as string[];

  const preview = courierStampLines({
    dispatcherName,
    dispatchCompany: signer.dispatchCompany,
    courierDriverName,
    courierCompany,
    at: now,
    courierSheetNo: sheet.courierSheetNo,
    waybillNo: sheet.waybills.join(", "),
  });

  const submit = async () => {
    const signature = pad.current?.toDataURL();
    if (!signature || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/courier/${sheet.id}/collect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatcherName, courierDriverName, courierCompany, checked, signature }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "The handover could not be recorded");
        setConfirming(false);
        return;
      }
      const failed = (data.filing?.failed ?? []) as { invoiceNo: string }[];
      onDone({
        filingProblem: failed.length
          ? `Signed. ${failed.length} signed cop${failed.length === 1 ? "y" : "ies"} still to be filed (${failed
              .map((f) => f.invoiceNo)
              .join(", ")}) — use Retry filing.`
          : null,
      });
    } catch {
      setError("Failed to connect to server — the handover was not recorded");
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex bg-black/50 animate-fade-in md:items-center md:justify-center md:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Collect and sign courier trip sheet ${sheet.courierSheetNo}`}
        className="bg-white w-full h-full flex flex-col overflow-hidden shadow-xl md:h-auto md:max-h-[94vh] md:max-w-3xl md:rounded-lg"
      >
        <div className="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-ink-border">
          <div className="flex-1 min-w-0">
            <h3 className="font-mono text-sm font-medium text-ink-black">Collect &amp; sign</h3>
            <p className="text-xs text-ink-muted mt-0.5 truncate">
              Courier trip sheet {sheet.courierSheetNo} · {sheet.customerName}
            </p>
          </div>
          <button type="button" className="act act-icon" onClick={onClose} disabled={submitting} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-5">
          {/* Summary */}
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <div>
              <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Customer</dt>
              <dd className="text-ink-black">{sheet.customerName}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">
                {sheet.waybills.length === 1 ? "Waybill" : "Waybills"}
              </dt>
              <dd className="text-ink-black font-mono break-words">{sheet.waybills.join(", ")}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Courier</dt>
              <dd className="text-ink-black">{courierCompany || "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Parcels</dt>
              <dd className="text-ink-black">{sheet.parcels ?? "—"}</dd>
            </div>
          </dl>

          {/* Invoices — viewing is optional */}
          <ul className="border border-ink-border rounded divide-y divide-ink-border">
            {sheet.invoices.map((inv) => (
              <li key={inv.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="font-mono text-ink-black">{inv.invoiceNo}</span>
                <span className="text-ink-muted flex-1">{inv.invoiceDate ? formatSheetDate(inv.invoiceDate) : ""}</span>
                {inv.invoiceFile && (
                  <button type="button" className="act" onClick={() => setViewing({ file: inv.invoiceFile!, invoiceNo: inv.invoiceNo })}>
                    View
                  </button>
                )}
              </li>
            ))}
          </ul>

          {!sheet.customerEmail && (
            <p className="px-3 py-2 text-sm rounded bg-ink-amber-dim border border-ink-amber/30" style={{ color: "var(--tone-amber-fg)" }}>
              No email for this customer yet. The courier can still sign — add a contact email so the delivery
              confirmation email can be sent.
            </p>
          )}

          <label className="flex items-start gap-3 px-3 py-3 rounded border border-ink-border bg-ink-surface/50 cursor-pointer">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 w-5 h-5" />
            <span className="text-sm text-ink-black">
              I have checked {parcels} parcel{parcels === 1 ? "" : "s"} for {count} invoice{count === 1 ? "" : "s"}
            </span>
          </label>

          {/* Who and when */}
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">Dispatcher name</span>
              <input value={dispatcherName} onChange={(e) => setDispatcherName(e.target.value)} maxLength={80} className={field} />
            </label>
            <label className="block">
              <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">Company</span>
              <input value={signer.dispatchCompany} disabled className={field} />
            </label>
            <label className="block">
              <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">Courier driver name *</span>
              <input
                value={courierDriverName}
                onChange={(e) => setCourierDriverName(e.target.value)}
                maxLength={80}
                autoComplete="off"
                className={field}
              />
            </label>
            <label className="block">
              <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">Courier company *</span>
              <input value={courierCompany} onChange={(e) => setCourierCompany(e.target.value)} maxLength={80} className={field} />
            </label>
            <label className="block sm:col-span-2">
              <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">Date &amp; time</span>
              <input value={`${formatStampTime(now)} (South African time — recorded when you submit)`} disabled className={field} />
            </label>
          </div>

          {/* What will be printed */}
          <div className="rounded border border-ink-border px-3 py-2.5 text-xs font-mono text-ink-black space-y-1 bg-white">
            <p className="text-[11px] text-ink-muted uppercase tracking-wide">On each invoice</p>
            <p>{preview.dispatched}</p>
            <p className="font-semibold">{preview.collected}</p>
          </div>

          <div>
            {portrait && <p className="text-xs text-ink-muted mb-2">Tip: turn the device sideways for more room to sign.</p>}
            <SignaturePad ref={pad} onChange={setSigned} height={170} label="Courier driver's signature" />
          </div>

          {error && <p className="text-sm text-ink-red">{error}</p>}
        </div>

        <div className="border-t border-ink-border bg-ink-surface/50 px-4 sm:px-6 py-3 flex flex-wrap items-center gap-3">
          <p className="flex-1 min-w-[12rem] text-xs text-ink-muted">
            {ready ? `The courier signs for ${count} invoice${count === 1 ? "" : "s"} at once.` : `Still needed: ${missing.join(", ")}.`}
          </p>
          <button type="button" onClick={onClose} disabled={submitting} className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black">
            Cancel
          </button>
          <button
            type="button"
            disabled={!ready || submitting}
            onClick={() => setConfirming(true)}
            className={`px-5 py-2.5 text-sm font-mono font-medium rounded transition-all ${
              ready && !submitting ? "bg-ink-green text-white hover:bg-ink-green-hover active:scale-[0.98]" : "bg-ink-border text-ink-muted cursor-not-allowed"
            }`}
          >
            Submit
          </button>
        </div>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => !submitting && setConfirming(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5 space-y-2">
              <h3 className="font-mono text-sm font-medium text-ink-black">Record the handover?</h3>
              <p className="text-sm text-ink-muted">
                {courierDriverName.trim()} of {courierCompany.trim()} signs for {count} invoice{count === 1 ? "" : "s"} on
                courier trip sheet {sheet.courierSheetNo}. Each invoice gets a signed copy, and the sheet becomes
                Collected. This cannot be undone.
              </p>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-ink-border bg-ink-surface/50">
              <button type="button" onClick={() => setConfirming(false)} disabled={submitting} className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black">
                Back
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                className="px-5 py-2.5 text-sm font-mono font-medium rounded bg-ink-green text-white hover:bg-ink-green-hover"
              >
                {submitting ? "Recording…" : "Yes, record it"}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewing && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black/70" onClick={() => setViewing(null)}>
          <div className="flex items-center gap-3 px-4 py-3 bg-white" onClick={(e) => e.stopPropagation()}>
            <span className="flex-1 font-mono text-sm text-ink-black">Invoice {viewing.invoiceNo}</span>
            <button type="button" className="act" onClick={() => setViewing(null)}>
              Close
            </button>
          </div>
          <div className="flex-1 overflow-auto bg-ink-surface" onClick={(e) => e.stopPropagation()}>
            <PdfViewer src={`/api/invoices/${encodeURIComponent(viewing.file)}`} title={`Invoice ${viewing.invoiceNo}`} />
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
