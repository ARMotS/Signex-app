"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import SignaturePad, { type SignaturePadHandle } from "@/components/SignaturePad";
import PdfViewer from "@/components/PdfViewer";
import {
  DIFF_REASONS,
  DIFF_REASON_LABEL,
  FAIL_REASONS,
  FAIL_REASON_LABEL,
  resolveConfirmation,
  type ConfirmMode,
  type DiffReason,
  type FailReason,
} from "@/lib/collection-confirm";

const MODE_LABEL: Record<ConfirmMode, string> = {
  AS_LISTED: "Collected as listed",
  NOT_AS_LISTED: "Not as listed",
  FAILED: "Collection failed",
};

type Outcome = "COLLECTED" | "PARTIAL" | "NOT_AVAILABLE" | "REFUSED";

interface CollectionData {
  id: string;
  collectionNo: string;
  type: "CREDIT_RETURN" | "NON_CREDIT_UPLIFT";
  upliftSubtype: string | null;
  notes: string | null;
  originalInvoiceNo: string | null;
  status: string;
  expectedQty: number | null;
  sourceFilePath: string | null;
  stop: { customerName: string; stopNumber: number };
  /** The office's sheet, read into lines. Empty until the sheet is on file. */
  lines?: {
    lineNo: number;
    itemCode: string | null;
    shortName: string | null;
    description: string;
    qtyListed: number;
    isExtra?: boolean;
  }[];
}

const TYPE_LABEL: Record<CollectionData["type"], string> = {
  CREDIT_RETURN: "Credit Return",
  NON_CREDIT_UPLIFT: "Uplift",
};

const SUBTYPE_LABEL: Record<string, string> = {
  COMPANY_PARCEL: "Company parcel",
  EQUIPMENT_OR_CRATES: "Equipment / crates",
  DOCUMENTS: "Documents",
  SPECIAL_REQUEST: "Special request",
};

/**
 * The outcomes, in the order a driver meets them. "Collected" is first and
 * largest because it is what happens nearly every time; the three exceptions
 * sit together because they all lead to the same extra question.
 */
const OUTCOMES: { value: Outcome; label: string; hint: string }[] = [
  { value: "COLLECTED", label: "Collected", hint: "Everything on the sheet" },
  { value: "PARTIAL", label: "Partial", hint: "Some of it" },
  { value: "NOT_AVAILABLE", label: "Not available", hint: "Nothing to collect" },
  { value: "REFUSED", label: "Refused", hint: "Customer said no" },
];

/** Outcomes where something physically changed hands, so someone must sign. */
const NEEDS_SIGNATURE: Outcome[] = ["COLLECTED", "PARTIAL"];
const NEEDS_REASON: Outcome[] = ["PARTIAL", "NOT_AVAILABLE", "REFUSED"];

export default function CollectPage() {
  const params = useParams();
  const router = useRouter();
  const padRef = useRef<SignaturePadHandle>(null);

  const [collection, setCollection] = useState<CollectionData | null>(null);
  const [status, setStatus] = useState<"loading" | "idle" | "saving" | "done" | "error">(
    "loading"
  );
  const [errorMessage, setErrorMessage] = useState("");
  const [documentWarning, setDocumentWarning] = useState<string | null>(null);
  const [emailResult, setEmailResult] = useState<{
    outcome: string;
    recipient: string | null;
  } | null>(null);

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [collectedQty, setCollectedQty] = useState("");
  const [reason, setReason] = useState("");
  const [signedByName, setSignedByName] = useState("");
  const [hasSignature, setHasSignature] = useState(false);
  const [showDocument, setShowDocument] = useState(false);

  // Confirm-by-exception — used when the office's sheet has been read into lines.
  const [mode, setMode] = useState<ConfirmMode | null>(null);
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [reasons, setReasons] = useState<Record<number, DiffReason | "">>({});
  const [lineNotes, setLineNotes] = useState<Record<number, string>>({});
  const [extras, setExtras] = useState<{ description: string; qty: string }[]>([]);
  const [failReason, setFailReason] = useState<FailReason | "">("");
  const [failNote, setFailNote] = useState("");

  const collectionId = params.collectionId as string;

  const fetchCollection = useCallback(async () => {
    try {
      const res = await fetch(`/api/collections/${collectionId}`);
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || "Failed to load this collection");
        setStatus("error");
        return;
      }

      const loaded: CollectionData = data.collection;

      if (loaded.status !== "PENDING") {
        setErrorMessage("This collection has already been completed.");
        setStatus("error");
        return;
      }

      setCollection(loaded);
      // Pre-fill the quantity with what the office expects, which is the answer
      // nearly every time — the driver changes it only when it is wrong.
      if (loaded.expectedQty != null) setCollectedQty(String(loaded.expectedQty));
      setStatus("idle");
    } catch {
      setErrorMessage("Failed to connect to server");
      setStatus("error");
    }
    // setCollectedQty is stable; listed because the React Compiler infers it.
  }, [collectionId, setCollectedQty]);

  useEffect(() => {
    fetchCollection();
  }, [fetchCollection]);

  // The sheet's lines, when it has been read: the driver confirms against them.
  const listed = (collection?.lines ?? []).filter((l) => !l.isExtra);
  const hasLines = listed.length > 0;

  const confirmPayload = mode
    ? {
        mode,
        lines: listed.map((l) => ({
          lineNo: l.lineNo,
          qtyCollected: counts[l.lineNo] ?? l.qtyListed,
          diffReason: reasons[l.lineNo] || null,
          diffNote: lineNotes[l.lineNo]?.trim() || null,
        })),
        extras: extras
          .filter((e) => e.description.trim() || e.qty.trim())
          .map((e) => ({ description: e.description, qty: Number(e.qty) })),
        failReason: failReason || null,
        failNote: failNote.trim() || null,
      }
    : null;
  // The same rules the server applies — what is allowed here is what it accepts.
  const confirmation = hasLines && confirmPayload ? resolveConfirmation(listed, confirmPayload) : null;

  const needsSignature = hasLines
    ? confirmation?.ok === true && confirmation.needsSignature
    : outcome
    ? NEEDS_SIGNATURE.includes(outcome)
    : false;
  const needsReason = !hasLines && (outcome ? NEEDS_REASON.includes(outcome) : false);

  const qtyIsValid =
    outcome !== "PARTIAL" ||
    collection?.expectedQty == null ||
    collectedQty.trim() === "" ||
    Number(collectedQty) < collection.expectedQty;

  const signed = !needsSignature || (hasSignature && signedByName.trim().length > 0);
  const canSubmit = hasLines
    ? confirmation?.ok === true && signed
    : !!outcome && qtyIsValid && (!needsReason || reason.trim().length > 0) && signed;

  const handleConfirm = async () => {
    if (!collection || !canSubmit) return;
    if (!hasLines && !outcome) return;

    setStatus("saving");

    try {
      const res = await fetch(`/api/collections/${collection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          hasLines
            ? {
                ...confirmPayload,
                signedByName: needsSignature ? signedByName.trim() : undefined,
                signatureImage: needsSignature ? padRef.current?.toDataURL() : undefined,
              }
            : {
                status: outcome,
                exceptionReason: needsReason ? reason.trim() : undefined,
                collectedQty: collectedQty.trim() === "" ? null : Number(collectedQty.trim()),
                signedByName: needsSignature ? signedByName.trim() : undefined,
                signatureImage: needsSignature ? padRef.current?.toDataURL() : undefined,
              }
        ),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || "Failed to record this collection");
        setStatus("error");
        return;
      }

      // The collection is recorded either way. A document that could not be
      // written is the office's problem to finish, not a reason to tell the
      // driver their work did not save.
      setDocumentWarning(data.documentError ?? null);
      setEmailResult(data.email ?? null);
      setStatus("done");
    } catch {
      setErrorMessage("Failed to connect to server. Please try again.");
      setStatus("error");
    }
  };

  // ─── Loading ──────────────────────────────────────────────────
  if (status === "loading") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="w-8 h-8 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mb-4" />
        <p className="text-sm font-mono text-ink-muted">Loading collection…</p>
      </div>
    );
  }

  // ─── Error ────────────────────────────────────────────────────
  if (status === "error") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="w-16 h-16 rounded-full bg-ink-red-dim flex items-center justify-center mb-4">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#E84040" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <p className="font-mono text-sm text-ink-red mb-2 text-center">{errorMessage}</p>
        <button
          onClick={() => router.push("/run")}
          className="mt-4 px-4 py-2 text-xs font-mono bg-ink-card border border-ink-border rounded hover:bg-ink-surface transition-colors"
        >
          ← Back to Run Sheet
        </button>
      </div>
    );
  }

  // ─── Done ─────────────────────────────────────────────────────
  if (status === "done") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 animate-scale-in">
        <div className="w-16 h-16 rounded-full bg-ink-amber-dim flex items-center justify-center mb-4">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#E0A030" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7h18l-1.5 12a2 2 0 0 1-2 1.8H6.5a2 2 0 0 1-2-1.8Z" />
            <path d="M8 7V5a4 4 0 0 1 8 0v2" />
          </svg>
        </div>
        <h2 className="font-mono text-xl font-medium text-ink-black mb-1">
          Collection recorded
        </h2>
        <p className="text-sm text-ink-muted text-center mb-4">
          {collection?.collectionNo} ·{" "}
          {hasLines && mode ? MODE_LABEL[mode] : OUTCOMES.find((o) => o.value === outcome)?.label}
        </p>

        {/* The receipt email went as part of Confirm. A failure is the office's
            to resend — the driver is told, not asked to do anything. */}
        {emailResult &&
          (emailResult.outcome === "sent" || emailResult.outcome === "already_sent" ? (
            <p className="text-xs font-mono text-ink-green text-center mb-3">
              Receipt emailed{emailResult.recipient ? ` to ${emailResult.recipient}` : ""}
            </p>
          ) : emailResult.outcome === "no_email" ? (
            <p className="text-xs font-mono text-ink-muted text-center mb-3">
              No email address on file for this customer — the office will send the receipt.
            </p>
          ) : emailResult.outcome === "in_flight" ? null : (
            <div className="px-4 py-2.5 rounded bg-ink-amber-dim border border-ink-amber/20 max-w-xs mb-3">
              <p className="text-xs font-mono text-ink-amber text-center">
                The receipt could not be emailed. The collection is saved — the office will resend it.
              </p>
            </div>
          ))}

        {documentWarning && (
          <div className="px-4 py-2.5 rounded bg-ink-amber-dim border border-ink-amber/20 max-w-xs">
            <p className="text-xs font-mono text-ink-amber text-center">
              {documentWarning} The office will pick this up.
            </p>
          </div>
        )}

        <button
          onClick={() => router.push("/run")}
          className="mt-4 px-4 py-2 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
        >
          ← Back to run
        </button>
      </div>
    );
  }

  // ─── Main ─────────────────────────────────────────────────────
  const isCredit = collection?.type === "CREDIT_RETURN";

  return (
    <div className="flex-1 flex flex-col animate-fade-in">
      {/* Header */}
      <div className="bg-ink-card border-b border-ink-border px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono uppercase tracking-wide ${
                  isCredit
                    ? "bg-ink-amber-dim text-ink-amber"
                    : "bg-ink-blue-dim text-ink-blue"
                }`}
              >
                {collection ? TYPE_LABEL[collection.type] : ""}
              </span>
              <p className="font-mono text-sm font-medium text-ink-black truncate">
                {collection?.collectionNo}
              </p>
            </div>
            <p className="text-xs text-ink-muted mt-0.5 truncate">
              {collection?.stop.customerName}
              {collection?.upliftSubtype
                ? ` · ${SUBTYPE_LABEL[collection.upliftSubtype] ?? collection.upliftSubtype}`
                : ""}
            </p>
            {collection?.originalInvoiceNo && (
              <p className="text-[11px] text-ink-muted-light mt-0.5">
                Against invoice {collection.originalInvoiceNo}
              </p>
            )}
            {collection?.notes && (
              <p className="text-[11px] text-ink-muted-light mt-0.5">{collection.notes}</p>
            )}
          </div>
          <button
            onClick={() => router.push("/run")}
            className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors shrink-0"
          >
            Cancel
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* What the office's sheet lists — read-only. The sheet is the source
            of truth for what to bring back; there is nothing to pick here. */}
        {(collection?.lines?.length ?? 0) > 0 && (
          <div className="px-4 py-3 border-b border-ink-border">
            <p className="text-[10px] font-mono uppercase tracking-wide text-ink-muted-light mb-2">
              To collect · {collection!.lines!.reduce((n, l) => n + l.qtyListed, 0)} item
              {collection!.lines!.reduce((n, l) => n + l.qtyListed, 0) === 1 ? "" : "s"}
            </p>
            <ul className="space-y-1.5">
              {collection!.lines!.map((line) => (
                <li key={line.lineNo} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink-black leading-snug">{line.description}</p>
                    {(line.itemCode || line.shortName) && (
                      <p className="text-[11px] font-mono text-ink-muted-light truncate">
                        {line.itemCode ?? line.shortName}
                      </p>
                    )}
                  </div>
                  <span className="shrink-0 font-mono text-sm font-medium text-ink-black">×{line.qtyListed}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Source document — collapsed by default. A driver wants the outcome
            buttons first; the paperwork is there to check against, not to read. */}
        {collection?.sourceFilePath ? (
          <div className="border-b border-ink-border">
            <button
              onClick={() => setShowDocument((v) => !v)}
              className="w-full px-4 py-2.5 flex items-center justify-between text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
            >
              <span>{showDocument ? "Hide" : "View"} collection document</span>
              <span>{showDocument ? "▲" : "▼"}</span>
            </button>
            {showDocument && (
              <PdfViewer
                src={`/api/collections/document/${encodeURIComponent(collection.sourceFilePath)}`}
                title={`Collection ${collection.collectionNo}`}
                className="h-[45vh]"
              />
            )}
          </div>
        ) : (
          <div className="px-4 py-2.5 border-b border-ink-border bg-ink-surface">
            <p className="text-[11px] font-mono text-ink-muted">
              No collection document on file — a receipt will be generated
            </p>
          </div>
        )}

        {/* Confirm-by-exception: the sheet was read, so the driver confirms it
            in one tap, records only what differs, or says why it failed. */}
        {hasLines && (
          <div className="px-4 py-4 space-y-4">
            <p className="text-xs font-mono text-ink-muted uppercase tracking-wide">What happened?</p>
            <button
              onClick={() => setMode("AS_LISTED")}
              className={`w-full p-4 rounded border text-left transition-all touch-target ${
                mode === "AS_LISTED" ? "border-ink-green bg-ink-green-dim" : "border-ink-border bg-ink-card"
              }`}
            >
              <p className={`font-mono text-base font-medium ${mode === "AS_LISTED" ? "text-ink-green" : "text-ink-black"}`}>
                Collected as listed
              </p>
              <p className="text-[11px] text-ink-muted mt-0.5">Everything on the sheet came back</p>
            </button>
            <div className="grid grid-cols-2 gap-2">
              {(["NOT_AS_LISTED", "FAILED"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`p-3 rounded border text-left transition-all touch-target ${
                    mode === m ? "border-ink-green bg-ink-green-dim" : "border-ink-border bg-ink-card"
                  }`}
                >
                  <p className={`font-mono text-sm font-medium ${mode === m ? "text-ink-green" : "text-ink-black"}`}>
                    {MODE_LABEL[m]}
                  </p>
                  <p className="text-[11px] text-ink-muted mt-0.5">
                    {m === "NOT_AS_LISTED" ? "Record only what differs" : "Nothing collected"}
                  </p>
                </button>
              ))}
            </div>

            {mode === "NOT_AS_LISTED" && (
              <div className="space-y-3">
                {listed.map((line) => {
                  const count = counts[line.lineNo] ?? line.qtyListed;
                  const short = count < line.qtyListed;
                  const set = (n: number) =>
                    setCounts((c) => ({ ...c, [line.lineNo]: Math.max(0, Math.min(line.qtyListed, n)) }));
                  return (
                    <div
                      key={line.lineNo}
                      className={`p-3 rounded border ${short || reasons[line.lineNo] ? "border-ink-amber/40 bg-ink-amber-dim/30" : "border-ink-border bg-ink-card"}`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm text-ink-black leading-snug">{line.description}</p>
                          <p className="text-[11px] font-mono text-ink-muted-light">Listed {line.qtyListed}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => set(count - 1)}
                            disabled={count <= 0}
                            aria-label={`One fewer ${line.description}`}
                            className="w-9 h-9 rounded border border-ink-border bg-white font-mono text-lg disabled:opacity-30 touch-target"
                          >
                            −
                          </button>
                          <span className="w-7 text-center font-mono text-base font-medium">{count}</span>
                          <button
                            onClick={() => set(count + 1)}
                            disabled={count >= line.qtyListed}
                            aria-label={`One more ${line.description}`}
                            className="w-9 h-9 rounded border border-ink-border bg-white font-mono text-lg disabled:opacity-30 touch-target"
                          >
                            +
                          </button>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {DIFF_REASONS.map((r) => (
                          <button
                            key={r}
                            onClick={() =>
                              setReasons((rs) => ({ ...rs, [line.lineNo]: rs[line.lineNo] === r ? "" : r }))
                            }
                            className={`px-2 py-1 rounded text-[11px] font-mono border ${
                              reasons[line.lineNo] === r
                                ? "bg-ink-amber text-white border-ink-amber"
                                : "bg-white text-ink-muted border-ink-border"
                            }`}
                          >
                            {DIFF_REASON_LABEL[r]}
                          </button>
                        ))}
                      </div>
                      {short && !reasons[line.lineNo] && (
                        <p className="text-[11px] text-ink-red mt-1">Say why fewer came back.</p>
                      )}
                      {reasons[line.lineNo] && (
                        <input
                          type="text"
                          value={lineNotes[line.lineNo] ?? ""}
                          onChange={(e) => setLineNotes((n) => ({ ...n, [line.lineNo]: e.target.value }))}
                          maxLength={300}
                          placeholder={reasons[line.lineNo] === "OTHER" ? "What happened? (required)" : "Note (optional)"}
                          className="mt-2 w-full px-2.5 py-2 bg-white border border-ink-border rounded font-mono text-xs focus:border-ink-green outline-none"
                        />
                      )}
                    </div>
                  );
                })}

                {extras.map((extra, i) => (
                  <div key={i} className="p-3 rounded border border-ink-blue/30 bg-ink-blue-dim/30 flex items-center gap-2">
                    <input
                      type="text"
                      value={extra.description}
                      onChange={(e) =>
                        setExtras((xs) => xs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))
                      }
                      maxLength={120}
                      placeholder="Item not on the sheet"
                      className="flex-1 min-w-0 px-2.5 py-2 bg-white border border-ink-border rounded font-mono text-xs focus:border-ink-green outline-none"
                    />
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={extra.qty}
                      onChange={(e) => setExtras((xs) => xs.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))}
                      aria-label="How many"
                      className="w-16 px-2 py-2 bg-white border border-ink-border rounded font-mono text-xs focus:border-ink-green outline-none"
                    />
                    <button
                      onClick={() => setExtras((xs) => xs.filter((_, j) => j !== i))}
                      aria-label="Remove this item"
                      className="text-ink-muted hover:text-ink-red font-mono text-sm px-1"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => setExtras((xs) => [...xs, { description: "", qty: "1" }])}
                  className="text-xs font-mono text-ink-blue hover:underline"
                >
                  + Item handed over that is not on the sheet
                </button>

                {confirmation && !confirmation.ok && (
                  <p className="text-[11px] text-ink-muted">{confirmation.error}</p>
                )}
              </div>
            )}

            {mode === "FAILED" && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  {FAIL_REASONS.map((r) => (
                    <button
                      key={r}
                      onClick={() => setFailReason(r)}
                      className={`p-2.5 rounded border text-left text-xs font-mono touch-target ${
                        failReason === r ? "border-ink-green bg-ink-green-dim text-ink-green" : "border-ink-border bg-ink-card text-ink-black"
                      }`}
                    >
                      {FAIL_REASON_LABEL[r]}
                    </button>
                  ))}
                </div>
                <textarea
                  value={failNote}
                  onChange={(e) => setFailNote(e.target.value)}
                  rows={2}
                  maxLength={300}
                  placeholder={failReason === "OTHER" ? "What happened? (required)" : "Note for the office (optional)"}
                  className="w-full px-3 py-2.5 bg-ink-card border border-ink-border rounded font-mono text-sm focus:border-ink-green outline-none resize-none"
                />
                <p className="text-[11px] text-ink-muted-light">No signature — nothing changed hands.</p>
              </div>
            )}

            {needsSignature && (
              <>
                <div>
                  <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-2">
                    Who is signing <span className="text-ink-red">*</span>
                  </label>
                  <input
                    type="text"
                    value={signedByName}
                    onChange={(e) => setSignedByName(e.target.value)}
                    className="w-full px-3 py-2.5 bg-ink-card border border-ink-border rounded font-mono text-sm focus:border-ink-green outline-none"
                    placeholder="Name of the person handing it over"
                  />
                </div>
                <SignaturePad ref={padRef} onChange={setHasSignature} />
              </>
            )}
          </div>
        )}

        {/* Outcome — a collection whose sheet was never read */}
        {!hasLines && (
        <div className="px-4 py-4">
          <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-3">
            What happened?
          </p>
          <div className="grid grid-cols-2 gap-2">
            {OUTCOMES.map((o) => (
              <button
                key={o.value}
                onClick={() => {
                  setOutcome(o.value);
                  // The quantity is pre-filled with what the office expects,
                  // which is the answer for COLLECTED and the one answer PARTIAL
                  // cannot be. Clearing it here makes the driver type the real
                  // number instead of meeting a validation error on submit.
                  if (o.value === "PARTIAL" && collection?.expectedQty != null) {
                    setCollectedQty((prev) =>
                      prev === String(collection.expectedQty) ? "" : prev
                    );
                  }
                  if (o.value === "COLLECTED" && collection?.expectedQty != null) {
                    setCollectedQty((prev) =>
                      prev === "" ? String(collection.expectedQty) : prev
                    );
                  }
                }}
                className={`p-3 rounded border text-left transition-all touch-target ${
                  outcome === o.value
                    ? "border-ink-green bg-ink-green-dim"
                    : "border-ink-border bg-ink-card hover:border-ink-muted-light"
                }`}
              >
                <p
                  className={`font-mono text-sm font-medium ${
                    outcome === o.value ? "text-ink-green" : "text-ink-black"
                  }`}
                >
                  {o.label}
                </p>
                <p className="text-[11px] text-ink-muted mt-0.5">{o.hint}</p>
              </button>
            ))}
          </div>
        </div>
        )}

        {!hasLines && outcome && (
          <div className="px-4 pb-4 space-y-4">
            {/* Quantity — only where something was taken */}
            {(outcome === "COLLECTED" || outcome === "PARTIAL") && (
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-2">
                  How many collected
                  {collection?.expectedQty != null && (
                    <span className="ml-1 normal-case tracking-normal text-ink-muted-light">
                      (expected {collection.expectedQty})
                    </span>
                  )}
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={outcome === "PARTIAL" && collection?.expectedQty != null ? collection.expectedQty - 1 : undefined}
                  value={collectedQty}
                  onChange={(e) => setCollectedQty(e.target.value)}
                  className="w-full px-3 py-2.5 bg-ink-card border border-ink-border rounded font-mono text-sm focus:border-ink-green outline-none"
                  placeholder={outcome === "PARTIAL" ? "How many actually came back" : "0"}
                />
                {outcome === "PARTIAL" &&
                  collection?.expectedQty != null &&
                  collectedQty.trim() !== "" &&
                  Number(collectedQty) >= collection.expectedQty && (
                    <p className="text-[11px] text-ink-red mt-1">
                      A partial collection has to be fewer than the {collection.expectedQty}{" "}
                      expected — use Collected if you took them all.
                    </p>
                  )}
              </div>
            )}

            {needsReason && (
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-2">
                  Reason <span className="text-ink-red">*</span>
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2.5 bg-ink-card border border-ink-border rounded font-mono text-sm focus:border-ink-green outline-none resize-none"
                  placeholder={
                    outcome === "PARTIAL"
                      ? "Why only part of it?"
                      : outcome === "REFUSED"
                      ? "What did the customer say?"
                      : "Why was there nothing to collect?"
                  }
                />
                <p className="text-[11px] text-ink-muted-light mt-1">
                  The office needs this to work out the credit.
                </p>
              </div>
            )}

            {needsSignature && (
              <>
                <div>
                  <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-2">
                    Who is signing <span className="text-ink-red">*</span>
                  </label>
                  <input
                    type="text"
                    value={signedByName}
                    onChange={(e) => setSignedByName(e.target.value)}
                    className="w-full px-3 py-2.5 bg-ink-card border border-ink-border rounded font-mono text-sm focus:border-ink-green outline-none"
                    placeholder="Name of the person handing it over"
                  />
                </div>

                <SignaturePad ref={padRef} onChange={setHasSignature} />
              </>
            )}
          </div>
        )}
      </div>

      {/* Confirm */}
      <div className="bg-ink-card border-t border-ink-border p-4">
        <button
          onClick={handleConfirm}
          disabled={!canSubmit || status === "saving"}
          className="w-full py-2.5 bg-ink-green text-white text-sm font-mono font-medium rounded disabled:opacity-40 disabled:cursor-not-allowed hover:bg-ink-green-hover active:scale-[0.98] transition-all touch-target"
        >
          {status === "saving" ? "Saving…" : "Confirm collection"}
        </button>
      </div>
    </div>
  );
}
