"use client";

/**
 * One courier trip sheet: what stands in the way of the courier signing for
 * it, and the fix beside each problem — upload the missing PDF, take an
 * invoice off the sheet, link or create the customer's contact. The courier's
 * details, the invoices, the original Excel and the history follow.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import CourierStatusBadge, { formatSheetDate, type CourierStatus } from "@/components/admin/courier/CourierStatusBadge";
import CollectAndSign from "@/components/admin/courier/CollectAndSign";

interface Issue {
  code: string;
  level: "block" | "warning";
  invoiceNo?: string;
  message: string;
}

interface Sheet {
  id: string;
  courierSheetNo: string;
  sheetDate: string;
  courierCompany: string | null;
  customerName: string;
  customerEmail: string | null;
  parcels: number | null;
  waybills: string[];
  status: CourierStatus;
  issues: Issue[];
  checkedAt: string | null;
  sourceFileName: string;
  sourceFilePath: string | null;
  sourceFileError: string | null;
  originalSaved: boolean;
  readWith: string;
  importedByName: string | null;
  dispatcherName: string | null;
  dispatchCompany: string | null;
  courierDriverName: string | null;
  collectedAt: string | null;
  filingCompletedAt: string | null;
  filingError: string | null;
  signatureHeld: boolean;
  emailStatus: "NOT_SENT" | "SENDING" | "SENT" | "FAILED" | "NO_EMAIL";
  emailSentAt: string | null;
  emailRecipient: string | null;
  emailError: string | null;
  reminderSentAt: string | null;
  confirmedAt: string | null;
  confirmTokenExpiresAt: string | null;
  createdAt: string;
  contact: { id: string; companyName: string; email: string | null; contactPerson: string | null; phone: string | null } | null;
  invoices: {
    id: string;
    lineNo: number;
    invoiceNo: string;
    invoiceFile: string | null;
    invoiceDate: string | null;
    waybillNo: string;
    parcels: number | null;
    signedAt: string | null;
    signedFileName: string | null;
  }[];
}

interface AuditEntry {
  action: string;
  userName: string | null;
  details: string | null;
  createdAt: string;
}

const OPEN: CourierStatus[] = ["NEEDS_ATTENTION", "AWAITING_COLLECTION"];
const REMOVABLE = new Set(["ALREADY_SIGNED", "ON_LIVE_RUN", "ON_OTHER_COURIER_SHEET"]);

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function CourierSheetPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [signer, setSigner] = useState({ dispatcherName: "", dispatchCompany: "" });
  const [collecting, setCollecting] = useState(false);

  const load = useCallback(
    () =>
      fetch(`/api/courier/${id}`)
        .then(async (res) => {
          if (res.status === 404) {
            setNotFound(true);
            return;
          }
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          setSheet(data.sheet);
          setAudit(data.audit);
          if (data.signer) setSigner(data.signer);
        })
        .catch(() => setMessage({ ok: false, text: "Could not load the sheet" }))
        .finally(() => setLoading(false)),
    [id]
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** Run an action on the sheet; the answer is the sheet as it now stands. */
  const act = async (label: string, body: Record<string, unknown>, done?: string) => {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(`/api/courier/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage({ ok: false, text: data.error || "That did not work" });
        return false;
      }
      setSheet(data.sheet);
      if (done) setMessage({ ok: true, text: done });
      void load();
      return true;
    } catch {
      setMessage({ ok: false, text: "Failed to connect to server" });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    const res = await fetch(`/api/courier/${id}`, { method: "DELETE" });
    setBusy(null);
    if (res.ok) router.push("/courier");
    else setMessage({ ok: false, text: (await res.json()).error || "Could not delete the sheet" });
  };

  /** "Retry filing": stamp and file the signed copies not filed yet. */
  const retryFiling = async () => {
    setBusy("filing");
    setMessage(null);
    const res = await fetch(`/api/courier/${id}/file`, { method: "POST" }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setBusy(null);
    const failed = (data.filing?.failed ?? []) as unknown[];
    setMessage(
      res?.ok && failed.length === 0
        ? { ok: true, text: "Every signed copy is filed" }
        : { ok: false, text: data.error || `${failed.length} signed cop${failed.length === 1 ? "y is" : "ies are"} still not filed` }
    );
    void load();
  };

  /** Send (or with force, re-send) the customer's confirmation email. */
  const sendEmail = async (force: boolean) => {
    setBusy("email");
    setMessage(null);
    const res = await fetch(`/api/courier/${id}/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    setBusy(null);
    setMessage(
      data.outcome === "sent"
        ? { ok: true, text: `Email sent to ${data.recipient}` }
        : { ok: false, text: data.error || "The email could not be sent" }
    );
    if (data.sheet) setSheet(data.sheet);
    void load();
  };

  const retryOriginal = async () => {
    setBusy("original");
    setMessage(null);
    const res = await fetch(`/api/courier/${id}/original`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setBusy(null);
    setMessage(res.ok ? { ok: true, text: "Original sheet saved" } : { ok: false, text: data.error || "Still could not save it" });
    void load();
  };

  if (loading) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (notFound || !sheet) {
    return (
      <div className="animate-fade-in">
        <Link href="/courier" className="text-sm text-ink-muted hover:text-ink-black">
          ← Courier
        </Link>
        <p className="mt-4 text-sm text-ink-black">Courier trip sheet not found.</p>
      </div>
    );
  }

  const open = OPEN.includes(sheet.status);
  const blocks = sheet.issues.filter((i) => i.level === "block");
  const warnings = sheet.issues.filter((i) => i.level === "warning");
  const lineFor = (invoiceNo?: string) => sheet.invoices.find((l) => l.invoiceNo === invoiceNo);

  return (
    <div className="animate-fade-in space-y-5">
      <Link href="/courier" className="text-sm text-ink-muted hover:text-ink-black">
        ← Courier
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[16rem]">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-lg font-medium text-ink-black">Courier trip sheet {sheet.courierSheetNo}</h1>
            <CourierStatusBadge status={sheet.status} />
          </div>
          <p className="text-sm text-ink-muted mt-1">
            {sheet.customerName} · {formatSheetDate(sheet.sheetDate)} · {sheet.invoices.length} invoice
            {sheet.invoices.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {open && (
            <button type="button" className="act" disabled={busy !== null} onClick={() => act("recheck", { action: "recheck" }, "Checked again")}>
              {busy === "recheck" ? "Checking…" : "Re-check"}
            </button>
          )}
          {open && (
            <button
              type="button"
              className="act act-primary"
              disabled={sheet.status !== "AWAITING_COLLECTION" || busy !== null}
              title={sheet.status === "AWAITING_COLLECTION" ? undefined : "Fix what is listed below first"}
              onClick={() => setCollecting(true)}
            >
              Collect &amp; sign
            </button>
          )}
          {open && (
            <button type="button" className="act act-danger" disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </div>
      </div>

      {message && (
        <p className={`text-sm font-mono ${message.ok ? "text-ink-green" : "text-ink-red"}`}>
          {message.ok ? "✓" : "✕"} {message.text}
        </p>
      )}

      {/* The handover, once the courier has signed */}
      {sheet.collectedAt && (
        <section className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <h2 className="px-5 py-3 border-b border-ink-border font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
            Handover
          </h2>
          <div className="px-5 py-4 space-y-2 text-sm">
            <p className="text-ink-black">
              Collected by <strong>{sheet.courierDriverName}</strong> from {sheet.courierCompany} on {fmtTime(sheet.collectedAt)}
            </p>
            <p className="text-ink-muted">
              Dispatched by {sheet.dispatcherName} from {sheet.dispatchCompany}
            </p>
            {(() => {
              const filed = sheet.invoices.filter((l) => l.signedAt).length;
              return sheet.filingCompletedAt ? (
                <p className="text-ink-green">
                  ✓ {filed === 1 ? "Signed copy filed" : `Signed copies filed for all ${filed} invoices`}
                </p>
              ) : (
                <div className="px-3 py-2 rounded bg-ink-red-dim border border-ink-red/20 space-y-2">
                  <p className="text-ink-red">
                    {filed} of {sheet.invoices.length} signed copies filed.{" "}
                    {sheet.filingError ?? "The rest have not been filed yet."}
                  </p>
                  <p className="text-xs text-ink-muted">
                    The handover is recorded either way. The customer&apos;s email waits until every copy is filed.
                  </p>
                  <button type="button" className="act act-amber" disabled={busy !== null || !sheet.signatureHeld} onClick={retryFiling}>
                    {busy === "filing" ? "Filing…" : "Retry filing"}
                  </button>
                </div>
              );
            })()}
            <CustomerConfirmation sheet={sheet} busy={busy !== null} onSend={sendEmail} />
          </div>
        </section>
      )}

      {/* What stands in the way */}
      {open && (blocks.length > 0 || warnings.length > 0) && (
        <section className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <h2 className="px-5 py-3 border-b border-ink-border font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
            {blocks.length ? "Before the courier can sign" : "Worth knowing"}
          </h2>
          <ul className="divide-y divide-ink-border">
            {blocks.map((issue, n) => {
              const line = lineFor(issue.invoiceNo);
              return (
                <li key={`b${n}`} className="px-5 py-3 flex flex-wrap items-center gap-3">
                  <span className="w-2 h-2 rounded-full bg-ink-red shrink-0" aria-hidden="true" />
                  <p className="flex-1 min-w-[14rem] text-sm text-ink-black">{issue.message}</p>
                  {issue.code === "INVOICE_NOT_FOUND" && issue.invoiceNo && (
                    <UploadPdf invoiceNo={issue.invoiceNo} disabled={busy !== null} onUploaded={() => act("recheck", { action: "recheck" }, `Invoice ${issue.invoiceNo} uploaded`)} onError={(t) => setMessage({ ok: false, text: t })} />
                  )}
                  {REMOVABLE.has(issue.code) && line && (
                    <button
                      type="button"
                      className="act act-danger"
                      disabled={busy !== null}
                      onClick={() => act(`rm-${line.id}`, { action: "removeInvoice", lineId: line.id }, `Invoice ${line.invoiceNo} removed from the sheet`)}
                    >
                      Remove from this sheet
                    </button>
                  )}
                </li>
              );
            })}
            {warnings.map((issue, n) => (
              <li key={`w${n}`} className="px-5 py-3 flex flex-wrap items-center gap-3">
                <span className="w-2 h-2 rounded-full bg-ink-amber shrink-0" aria-hidden="true" />
                <p className="flex-1 min-w-[14rem] text-sm" style={{ color: "var(--tone-amber-fg)" }}>
                  {issue.message}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Customer */}
        <section className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <h2 className="px-5 py-3 border-b border-ink-border font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
            Customer
          </h2>
          <div className="px-5 py-4 space-y-3 text-sm">
            <p className="text-ink-black font-medium">{sheet.customerName}</p>
            <ContactFixer sheet={sheet} open={open || sheet.status === "COLLECTED"} busy={busy !== null} act={act} setMessage={setMessage} />
          </div>
        </section>

        {/* Courier */}
        <section className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <h2 className="px-5 py-3 border-b border-ink-border font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
            Courier
          </h2>
          <CourierFields sheet={sheet} />
        </section>
      </div>

      {/* Invoices */}
      <section className="bg-ink-card border border-ink-border rounded overflow-hidden">
        <h2 className="px-5 py-3 border-b border-ink-border font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
          Invoices
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">
              <tr className="border-b border-ink-border">
                <th className="px-5 py-2 text-left font-normal">Invoice</th>
                <th className="px-5 py-2 text-left font-normal">Date</th>
                <th className="px-5 py-2 text-left font-normal">Waybill</th>
                <th className="px-5 py-2 text-right font-normal">Parcels</th>
                <th className="px-5 py-2 text-left font-normal">PDF</th>
                {open && <th className="px-5 py-2" />}
              </tr>
            </thead>
            <tbody>
              {sheet.invoices.map((l) => (
                <tr key={l.id} className="border-b border-ink-border last:border-0">
                  <td className="px-5 py-2.5 font-mono">{l.invoiceNo}</td>
                  <td className="px-5 py-2.5 text-ink-muted whitespace-nowrap">{l.invoiceDate ? formatSheetDate(l.invoiceDate) : "—"}</td>
                  <td className="px-5 py-2.5 font-mono text-ink-muted">{l.waybillNo}</td>
                  <td className="px-5 py-2.5 text-right">{l.parcels ?? ""}</td>
                  <td className="px-5 py-2.5">
                    {l.signedAt && l.signedFileName ? (
                      <a
                        href={`/api/invoices/${encodeURIComponent(l.signedFileName)}?signed=true`}
                        target="_blank"
                        rel="noopener"
                        className="text-ink-green underline-offset-2 hover:underline"
                      >
                        Signed copy
                      </a>
                    ) : l.invoiceFile ? (
                      <a
                        href={`/api/invoices/${encodeURIComponent(l.invoiceFile)}`}
                        target="_blank"
                        rel="noopener"
                        className="text-ink-black underline-offset-2 hover:underline"
                      >
                        View
                      </a>
                    ) : (
                      <span className="text-ink-red">No PDF</span>
                    )}
                  </td>
                  {open && (
                    <td className="px-5 py-2.5 text-right">
                      {sheet.invoices.length > 1 && (
                        <button
                          type="button"
                          className="act act-icon"
                          disabled={busy !== null}
                          title={`Remove invoice ${l.invoiceNo} from this sheet`}
                          aria-label={`Remove invoice ${l.invoiceNo} from this sheet`}
                          onClick={() => act(`rm-${l.id}`, { action: "removeInvoice", lineId: l.id }, `Invoice ${l.invoiceNo} removed from the sheet`)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* The original */}
        <section className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <h2 className="px-5 py-3 border-b border-ink-border font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
            Original sheet
          </h2>
          <div className="px-5 py-4 space-y-2 text-sm">
            <p className="text-ink-black font-mono break-all">{sheet.sourceFileName}</p>
            {sheet.originalSaved ? (
              <p className="text-xs text-ink-muted break-all">Saved to {sheet.sourceFilePath}</p>
            ) : (
              <p className="text-xs text-ink-red break-words">
                Original file not saved{sheet.sourceFileError ? ` — ${sheet.sourceFileError}` : ""}
              </p>
            )}
            <p className="text-xs text-ink-muted">
              Read with {sheet.readWith} · imported {fmtTime(sheet.createdAt)}
              {sheet.importedByName ? ` by ${sheet.importedByName}` : ""}
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <a href={`/api/courier/${sheet.id}/original`} className="act">
                Download original sheet
              </a>
              {!sheet.originalSaved && (
                <button type="button" className="act act-amber" disabled={busy !== null} onClick={retryOriginal}>
                  {busy === "original" ? "Saving…" : "Retry saving"}
                </button>
              )}
            </div>
          </div>
        </section>

        {/* History */}
        <section className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <h2 className="px-5 py-3 border-b border-ink-border font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
            History
          </h2>
          <ul className="px-5 py-3 space-y-2 text-sm max-h-72 overflow-y-auto">
            {audit.length === 0 && <li className="text-ink-muted">Nothing yet.</li>}
            {audit.map((a, n) => (
              <li key={n}>
                <p className="text-ink-black">{a.details}</p>
                <p className="text-xs text-ink-muted">
                  {fmtTime(a.createdAt)}
                  {a.userName ? ` · ${a.userName}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {collecting && (
        <CollectAndSign
          sheet={sheet}
          signer={signer}
          onClose={() => setCollecting(false)}
          onDone={({ filingProblem }) => {
            setCollecting(false);
            setMessage(filingProblem ? { ok: false, text: filingProblem } : { ok: true, text: "Handover recorded — signed copies filed" });
            void load();
          }}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-fade-in" onClick={() => busy === null && setConfirmDelete(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-5">
              <h3 className="font-mono text-sm font-medium text-ink-black">Delete courier trip sheet {sheet.courierSheetNo}?</h3>
              <p className="text-sm text-ink-muted mt-2">
                For a sheet imported by mistake. Its invoices are free to go on another sheet; the original Excel stays in
                its folder.
              </p>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-ink-border bg-ink-surface/50">
              <button type="button" onClick={() => setConfirmDelete(false)} disabled={busy !== null} className="px-4 py-2 text-sm font-mono text-ink-muted hover:text-ink-black">
                Cancel
              </button>
              <button type="button" onClick={remove} disabled={busy !== null} className="px-5 py-2.5 text-sm font-mono font-medium rounded bg-ink-red text-white hover:opacity-90">
                {busy === "delete" ? "Deleting…" : "Delete sheet"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

/** The customer's email and confirmation, once every signed copy is filed. */
function CustomerConfirmation({ sheet, busy, onSend }: { sheet: Sheet; busy: boolean; onSend: (force: boolean) => void }) {
  if (!sheet.filingCompletedAt && !sheet.confirmedAt) return null;
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "short", day: "numeric", month: "short" });

  if (sheet.confirmedAt) {
    return (
      <p className="text-ink-green pt-2 border-t border-ink-border">
        ✓ The customer confirmed the parcels arrived on {fmtTime(sheet.confirmedAt)}
      </p>
    );
  }

  const button = (label: string, force: boolean) => (
    <button type="button" className="act" disabled={busy} onClick={() => onSend(force)}>
      {label}
    </button>
  );

  return (
    <div className="pt-2 border-t border-ink-border space-y-2">
      {sheet.emailStatus === "SENT" && sheet.emailSentAt ? (
        <>
          <p className="text-ink-black">
            Confirmation email sent to {sheet.emailRecipient} on {fmtTime(sheet.emailSentAt)} — not confirmed yet.
          </p>
          <p className="text-xs text-ink-muted">
            {sheet.reminderSentAt
              ? `Reminder sent on ${fmtTime(sheet.reminderSentAt)}. If there is still no answer, phone the customer.`
              : `One reminder goes on ${day(new Date(new Date(sheet.emailSentAt).getTime() + 2 * 86_400_000).toISOString())} if they have not confirmed.`}
            {sheet.confirmTokenExpiresAt ? ` The link works until ${day(sheet.confirmTokenExpiresAt)}.` : ""}
          </p>
          {button("Resend email", true)}
        </>
      ) : sheet.emailStatus === "NO_EMAIL" ? (
        <div className="px-3 py-2 rounded bg-ink-amber-dim border border-ink-amber/30 space-y-2" style={{ color: "var(--tone-amber-fg)" }}>
          <p>No email address for this customer. Add one under Customer and the confirmation email goes by itself.</p>
          {button("Send email", false)}
        </div>
      ) : sheet.emailStatus === "FAILED" ? (
        <div className="px-3 py-2 rounded bg-ink-red-dim border border-ink-red/20 space-y-2">
          <p className="text-ink-red">The confirmation email did not go: {sheet.emailError ?? "the mail server rejected it"}</p>
          {button("Send again", false)}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-ink-muted">The confirmation email is being sent…</p>
          {button("Send email", false)}
        </div>
      )}
    </div>
  );
}

type Act = (label: string, body: Record<string, unknown>, done?: string) => Promise<boolean>;

const inputClass =
  "px-2 py-1.5 text-sm bg-white border border-ink-border rounded focus:outline-none focus:border-ink-green";

function UploadPdf({
  invoiceNo,
  disabled,
  onUploaded,
  onError,
}: {
  invoiceNo: string;
  disabled: boolean;
  onUploaded: () => void;
  onError: (text: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setUploading(true);
          const form = new FormData();
          form.append("file", file);
          form.append("invoiceNumber", invoiceNo);
          const res = await fetch("/api/invoices/upload", { method: "POST", body: form }).catch(() => null);
          setUploading(false);
          if (res?.ok) onUploaded();
          else onError((res && (await res.json().catch(() => ({}))).error) || "Upload failed");
        }}
      />
      <button type="button" className="act act-green" disabled={disabled || uploading} onClick={() => input.current?.click()}>
        {uploading ? "Uploading…" : "Upload PDF"}
      </button>
    </>
  );
}

function ContactFixer({
  sheet,
  open,
  busy,
  act,
  setMessage,
}: {
  sheet: Sheet;
  open: boolean;
  busy: boolean;
  act: Act;
  setMessage: (m: { ok: boolean; text: string } | null) => void;
}) {
  const [changing, setChanging] = useState(false);
  const [query, setQuery] = useState(sheet.customerName);
  const [results, setResults] = useState<{ id: string; companyName: string; email: string | null }[] | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [saving, setSaving] = useState(false);

  const search = async () => {
    const res = await fetch(`/api/contacts?limit=8&search=${encodeURIComponent(query.trim())}`).catch(() => null);
    setResults(res?.ok ? (await res.json()).contacts : []);
  };

  const link = async (contactId: string) => {
    if (await act("link", { action: "linkContact", contactId }, "Contact linked")) {
      setChanging(false);
      setResults(null);
    }
  };

  /** Create the contact (or give the linked one its missing email), then check again. */
  const saveEmail = async () => {
    const email = newEmail.trim();
    if (!email) return;
    setSaving(true);
    setMessage(null);
    try {
      if (sheet.contact) {
        const res = await fetch(`/api/contacts/${sheet.contact.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        await act(
          "recheck",
          { action: "recheck" },
          sheet.status === "COLLECTED" ? "Email added — the confirmation email is on its way" : "Email added"
        );
      } else {
        const res = await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyName: sheet.customerName, email }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        await link(data.id ?? data.contact?.id);
      }
      setNewEmail("");
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error && err.message ? err.message : "Could not save the contact" });
    } finally {
      setSaving(false);
    }
  };

  const contact = sheet.contact;
  return (
    <div className="space-y-3">
      {contact ? (
        <div>
          <p className="text-ink-black">
            {contact.companyName}
            {contact.contactPerson ? ` · ${contact.contactPerson}` : ""}
          </p>
          <p className={contact.email ? "text-ink-muted" : "text-ink-red"}>{contact.email || "No email on this contact"}</p>
        </div>
      ) : (
        <p className="text-ink-red">No contact linked.</p>
      )}

      {open && (!contact || !contact.email) && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="customer@example.co.za"
            aria-label="Customer email"
            className={`${inputClass} flex-1 min-w-[12rem]`}
          />
          <button type="button" className="act act-green" disabled={busy || saving || !newEmail.trim()} onClick={saveEmail}>
            {contact ? "Add email" : "Create contact"}
          </button>
        </div>
      )}

      {open && (
        <div>
          {!changing ? (
            <button type="button" className="act" onClick={() => setChanging(true)}>
              {contact ? "Link a different contact" : "Link an existing contact"}
            </button>
          ) : (
            <div className="space-y-2">
              <form
                className="flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void search();
                }}
              >
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search contacts"
                  className={`${inputClass} flex-1 min-w-[12rem]`}
                />
                <button type="submit" className="act">
                  Search
                </button>
                <button type="button" className="act" onClick={() => setChanging(false)}>
                  Cancel
                </button>
              </form>
              {results && results.length === 0 && (
                <p className="text-xs text-ink-muted">
                  No contacts match. Create one above, or on the{" "}
                  <Link href="/contacts" className="underline">
                    Contacts
                  </Link>{" "}
                  page.
                </p>
              )}
              {results && results.length > 0 && (
                <ul className="border border-ink-border rounded divide-y divide-ink-border">
                  {results.map((c) => (
                    <li key={c.id} className="px-3 py-2 flex items-center gap-2">
                      <span className="flex-1 min-w-0 truncate">
                        {c.companyName}
                        <span className="text-ink-muted"> · {c.email || "no email"}</span>
                      </span>
                      <button type="button" className="act act-green" disabled={busy} onClick={() => link(c.id)}>
                        Link
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The courier's details, read-only: waybill and parcels from the sheet, and
 * the company from its Courier column. A sheet in the older layout has none
 * until the courier driver signs, when it is typed on Collect & Sign.
 */
function CourierFields({ sheet }: { sheet: Sheet }) {
  const label = "text-[11px] font-mono text-ink-muted uppercase tracking-wide";
  return (
    <div className="px-5 py-4 text-sm">
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className={label}>{sheet.waybills.length === 1 ? "Waybill" : "Waybills"}</dt>
          <dd className="font-mono text-ink-black break-words">{sheet.waybills.join(", ")}</dd>
        </div>
        <div>
          <dt className={label}>Parcels</dt>
          <dd className="text-ink-black">{sheet.parcels ?? "—"}</dd>
        </div>
        <div className="col-span-2">
          <dt className={label}>Company</dt>
          <dd className="text-ink-black">
            {sheet.courierCompany || (
              <span className="text-ink-muted">Not on the sheet — entered when the courier signs</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}
