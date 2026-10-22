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
  courierService: string | null;
  courierContact: string | null;
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
          <button
            type="button"
            className="act act-primary"
            disabled
            title={blocks.length ? "Fix what is listed below first" : "Collect & sign arrives in the next update"}
          >
            Collect &amp; sign
          </button>
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
            <ContactFixer sheet={sheet} open={open} busy={busy !== null} act={act} setMessage={setMessage} />
          </div>
        </section>

        {/* Courier */}
        <section className="bg-ink-card border border-ink-border rounded overflow-hidden">
          <h2 className="px-5 py-3 border-b border-ink-border font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
            Courier
          </h2>
          <CourierFields sheet={sheet} open={open} busy={busy !== null} act={act} />
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
                    {l.invoiceFile ? (
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
        await act("recheck", { action: "recheck" }, "Email added");
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

function CourierFields({ sheet, open, busy, act }: { sheet: Sheet; open: boolean; busy: boolean; act: Act }) {
  const [values, setValues] = useState({
    courierCompany: sheet.courierCompany ?? "",
    courierService: sheet.courierService ?? "",
    courierContact: sheet.courierContact ?? "",
  });
  const changed =
    values.courierCompany !== (sheet.courierCompany ?? "") ||
    values.courierService !== (sheet.courierService ?? "") ||
    values.courierContact !== (sheet.courierContact ?? "");

  const fields: { key: keyof typeof values; label: string; placeholder: string }[] = [
    { key: "courierCompany", label: "Company", placeholder: "e.g. MJV" },
    { key: "courierService", label: "Service", placeholder: "e.g. MJV LOG JHB TO CUST 0 TO 99KG" },
    { key: "courierContact", label: "Contact", placeholder: "Phone" },
  ];

  return (
    <div className="px-5 py-4 space-y-3 text-sm">
      <dl className="grid grid-cols-2 gap-3">
        <div>
          <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">
            {sheet.waybills.length === 1 ? "Waybill" : "Waybills"}
          </dt>
          <dd className="font-mono text-ink-black break-words">{sheet.waybills.join(", ")}</dd>
        </div>
        <div>
          <dt className="text-[11px] font-mono text-ink-muted uppercase tracking-wide">Parcels</dt>
          <dd className="text-ink-black">{sheet.parcels ?? "—"}</dd>
        </div>
      </dl>
      {fields.map((f) => (
        <label key={f.key} className="block">
          <span className="block text-[11px] font-mono text-ink-muted uppercase tracking-wide mb-1">{f.label}</span>
          {open ? (
            <input
              type="text"
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.placeholder}
              className={`${inputClass} w-full`}
            />
          ) : (
            <span className="text-ink-black">{sheet[f.key] || "—"}</span>
          )}
        </label>
      ))}
      {open && changed && (
        <button type="button" className="act act-green" disabled={busy} onClick={() => act("fields", { action: "update", ...values }, "Courier details saved")}>
          Save courier details
        </button>
      )}
    </div>
  );
}
