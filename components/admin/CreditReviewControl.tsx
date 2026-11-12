"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { StatusBadge } from "@/components/ui/Chips";
import { CREDIT_CHARGES, CREDIT_CHARGE_LABEL, CREDIT_REJECT_REASONS, type CreditCharge } from "@/lib/collection-confirm";
import type { CreditNoteEffect } from "@/lib/collection-review";

/**
 * The dispatcher's decision on a credit return that came back: approve it for
 * credit, or reject it (reason required). Lives on the Collections tab and
 * works before or after the trip closes. Accounts makes the credit note only
 * once it is approved, so a note waits on it. The decision can be changed.
 *
 * The sheet's handling-charge boxes are ticked with it: optional, one at a time.
 *
 * A click answers at once (a spinner on the button pressed), and a decision the
 * server has accepted shows as made while the list catches up. Without that the
 * buttons came back to life between the answer and the reload, and it looked as
 * if the click had done nothing.
 */

export type { CreditNoteEffect };

export type DecisionResult = { ok: true; creditNotes: CreditNoteEffect[] } | { ok: false; error: string };

/** What the page says once a decision has gone through. */
export interface DecisionNote {
  text: string;
  /** Set when one credit note was affected: the page links to it. */
  creditNoteId?: string;
}

/** Sends one decision; what it did to the credit notes, or the error to show. */
export async function submitCreditDecision(
  id: string,
  decision: "APPROVE" | "REJECT",
  reason: string,
  charge: CreditCharge | null
): Promise<DecisionResult> {
  try {
    const res = await fetch(`/api/collections/${id}/review`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason: decision === "REJECT" ? reason.trim() : undefined, charge }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, creditNotes: data.creditNotes ?? [] };
    return { ok: false, error: data.error || "That did not work" };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

const noteNumbers = (notes: CreditNoteEffect[]) =>
  `Credit note${notes.length === 1 ? "" : "s"} ${notes.map((n) => n.creditNo ?? "without a number").join(", ")}`;

/** "Collection 1797 approved for credit. Credit note 407712 can now be signed." */
export function decisionNote(collectionNo: string, decision: "APPROVE" | "REJECT", notes: CreditNoteEffect[]): DecisionNote {
  const creditNoteId = notes.length === 1 ? notes[0].id : undefined;
  if (decision === "REJECT") {
    const lead = `Collection ${collectionNo} rejected for credit.`;
    return { text: notes.length ? `${lead} ${noteNumbers(notes)} flagged on the Credits page.` : lead, creditNoteId };
  }
  const lead = `Collection ${collectionNo} approved for credit.`;
  if (notes.length === 0) return { text: `${lead} Accounts can raise the credit note.` };
  const signable = notes.filter((n) => n.signable);
  const waiting = notes.filter((n) => !n.signable);
  const parts = [lead];
  if (signable.length) parts.push(`${noteNumbers(signable)} can now be signed.`);
  if (waiting.length) parts.push(`${noteNumbers(waiting)} still waiting on the Credits page.`);
  return { text: parts.join(" "), creditNoteId };
}

/** Inside a button that is working. */
export function ButtonSpinner() {
  return <span className="w-3 h-3 border-2 border-current border-r-transparent rounded-full animate-spin shrink-0" aria-hidden="true" />;
}

/**
 * Charged / NO Charge / 20% to Customer, as the sheet prints them. Real
 * checkboxes, but one at a time: ticking one clears the others, ticking it
 * again clears it.
 */
export function ChargeBoxes({
  value,
  onChange,
  disabled,
}: {
  value: CreditCharge | null;
  onChange: (next: CreditCharge | null) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 border-0 p-0 m-0" disabled={disabled}>
      <legend className="sr-only">Handling charge (optional)</legend>
      {CREDIT_CHARGES.map((c) => (
        <label key={c} className="inline-flex items-center gap-1.5 text-xs cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={value === c}
            onChange={() => onChange(value === c ? null : c)}
            onClick={(e) => e.stopPropagation()}
            className="w-3.5 h-3.5 rounded border-ink-border accent-[#00C07F]"
          />
          {CREDIT_CHARGE_LABEL[c]}
        </label>
      ))}
    </fieldset>
  );
}

/** Where a collection's credit stands. */
export function CreditBadge({
  review,
  reason,
  by,
}: {
  review?: "APPROVED" | "REJECTED" | null;
  reason?: string | null;
  by?: string | null;
}) {
  const who = by ? ` by ${by}` : "";
  if (review === "APPROVED") {
    return (
      <StatusBadge tone="green" dot title={`Approved for credit${who}`}>
        Approved for credit
      </StatusBadge>
    );
  }
  if (review === "REJECTED") {
    return (
      <StatusBadge tone="red" dot title={`Rejected for credit${who}${reason ? ` — ${reason}` : ""}`}>
        Rejected for credit
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="amber" dot title="Accounts makes the credit note once this is approved">
      Awaiting approval
    </StatusBadge>
  );
}

export default function CreditReviewControl({
  collection,
  onChanged,
  hideBadge,
}: {
  collection: {
    id: string;
    collectionNo: string;
    creditReview?: "APPROVED" | "REJECTED" | null;
    creditReviewReason?: string | null;
    creditReviewedBy?: string | null;
    creditCharge?: CreditCharge | null;
  };
  onChanged: (note: DecisionNote) => void;
  /** The row already shows where the credit stands. */
  hideBadge?: boolean;
}) {
  const [changing, setChanging] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [charge, setCharge] = useState<CreditCharge | null>(collection.creditCharge ?? null);
  const [pressed, setPressed] = useState<"APPROVE" | "REJECT" | "CHARGE" | null>(null);
  const [made, setMade] = useState<{ to: "APPROVED" | "REJECTED"; from: "APPROVED" | "REJECTED" | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = pressed !== null;

  const decided = collection.creditReview;

  const decide = async (decision: "APPROVE" | "REJECT", why = reason, chargeOnly = false) => {
    setPressed(chargeOnly ? "CHARGE" : decision);
    setError(null);
    const result = await submitCreditDecision(collection.id, decision, why, charge);
    setPressed(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRejecting(false);
    setChanging(false);
    setReason("");
    if (!chargeOnly) {
      setMade({ to: decision === "APPROVE" ? "APPROVED" : "REJECTED", from: decided ?? null });
      // Only a backstop for a reload that never lands: the row normally moves first.
      setTimeout(() => setMade(null), 10_000);
    }
    onChanged(
      chargeOnly
        ? { text: `Handling charge saved on collection ${collection.collectionNo}.` }
        : decisionNote(collection.collectionNo, decision, result.creditNotes)
    );
  };

  // Accepted by the server; the list has not caught up yet.
  if (made && (decided ?? null) === made.from) {
    return (
      <span role="status">
        <StatusBadge tone={made.to === "APPROVED" ? "green" : "red"} dot className="animate-scale-in">
          {made.to === "APPROVED" ? "Approved for credit" : "Rejected for credit"}
        </StatusBadge>
      </span>
    );
  }

  return (
    <>
      {!hideBadge && <CreditBadge review={decided} reason={collection.creditReviewReason} by={collection.creditReviewedBy} />}

      {(!decided || changing) && (
        <>
          <ChargeBoxes value={charge} onChange={setCharge} disabled={busy} />
          {/* Same decision, a different box. */}
          {decided && charge !== (collection.creditCharge ?? null) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                decide(decided === "APPROVED" ? "APPROVE" : "REJECT", collection.creditReviewReason ?? "", true);
              }}
              disabled={busy}
              aria-busy={pressed === "CHARGE"}
              className={`act ${pressed === "CHARGE" ? "!opacity-100" : ""}`}
            >
              {pressed === "CHARGE" && <ButtonSpinner />}
              {pressed === "CHARGE" ? "Saving…" : "Save charge"}
            </button>
          )}
          {decided !== "APPROVED" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                decide("APPROVE");
              }}
              disabled={busy}
              aria-busy={pressed === "APPROVE"}
              className={`act act-green ${pressed === "APPROVE" ? "!opacity-100" : ""}`}
              title="The goods are fine — clear this collection for credit"
            >
              {pressed === "APPROVE" ? (
                <ButtonSpinner />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              )}
              {pressed === "APPROVE" ? "Approving…" : "Approve"}
            </button>
          )}
          {decided !== "REJECTED" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setRejecting(true);
              }}
              disabled={busy}
              className="act act-danger"
              title="Not creditable — kept on record, never matched to a credit note"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
              </svg>
              Reject…
            </button>
          )}
          {changing && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setChanging(false);
                setCharge(collection.creditCharge ?? null);
              }}
              className="act"
            >
              Cancel
            </button>
          )}
        </>
      )}
      {decided && !changing && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setCharge(collection.creditCharge ?? null);
            setChanging(true);
          }}
          className="act"
          title="Change the decision"
        >
          Change
        </button>
      )}
      {error && <span className="text-[11px] font-mono text-[color:var(--tone-red-fg)]">{error}</span>}

      {rejecting && (
        <RejectCreditDialog
          title={`Reject collection ${collection.collectionNo} for credit`}
          reason={reason}
          onReason={setReason}
          charge={charge}
          onCharge={setCharge}
          busy={busy}
          error={error}
          onCancel={() => setRejecting(false)}
          onConfirm={() => decide("REJECT")}
        />
      )}
    </>
  );
}

/** The reason (required) and the charge boxes, for one rejection or several. */
export function RejectCreditDialog({
  title,
  reason,
  onReason,
  charge,
  onCharge,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  reason: string;
  onReason: (next: string) => void;
  charge: CreditCharge | null;
  onCharge: (next: CreditCharge | null) => void;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // On the page body, not inside the trip card — see CollectionSheetPanel.
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 animate-fade-in"
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 space-y-4">
          <div>
            <h3 className="font-mono text-sm font-medium text-ink-black">{title}</h3>
            <p className="text-xs text-ink-muted mt-1">
              It stays on record with its signed receipt, but no credit note is matched to it. If one
              arrives, the Credits page flags it.
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CREDIT_REJECT_REASONS.map((r) => (
              <button
                key={r}
                onClick={() => onReason(r)}
                className={`act ${reason === r ? "!bg-ink-black !text-white !border-ink-black" : ""}`}
              >
                {r}
              </button>
            ))}
          </div>
          <textarea
            value={reason}
            onChange={(e) => onReason(e.target.value)}
            rows={2}
            maxLength={600}
            placeholder="Why it is not creditable (required)"
            className="w-full px-3 py-2 text-sm border border-ink-border rounded focus:outline-none focus:border-ink-black resize-none"
          />
          <div>
            <p className="text-[11px] font-mono text-ink-muted mb-1.5">Handling charge (optional)</p>
            <ChargeBoxes value={charge} onChange={onCharge} disabled={busy} />
          </div>
          {error && <p className="text-xs text-ink-red">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-ink-border bg-ink-surface/50">
          <button onClick={onCancel} disabled={busy} className="act">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || reason.trim().length < 3}
            aria-busy={busy}
            className={`act act-red ${busy ? "!opacity-100" : ""}`}
          >
            {busy && <ButtonSpinner />}
            {busy ? "Rejecting…" : "Reject for credit"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
