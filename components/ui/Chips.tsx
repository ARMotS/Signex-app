/**
 * The document chip and the status badge — the two kinds of information on a
 * card. Neither can be pressed; anything that can is a `.act` button (see
 * app/globals.css, "One size for badges, chips and buttons").
 *
 * A document chip says WHAT the document is before its number, so an invoice
 * is never mistaken for a collection:
 *   INV · 900101  an invoice
 *   CR  · 900001  a credit return against an invoice
 *   CO  · 900003  a collection with no invoice behind it (never credited)
 *   UPL · 900020  a non-credit uplift (crates, parcels, documents)
 *   CN  · 407712  a credit note
 * Its tint is its status, the same palette everywhere.
 */

export type DocKind = "INV" | "CR" | "CO" | "UPL" | "CN";
export type Tone = "idle" | "amber" | "green" | "violet" | "red" | "blue" | "ref";

const KIND_NAME: Record<DocKind, string> = {
  INV: "Invoice",
  CR: "Credit return",
  CO: "Collection",
  UPL: "Uplift",
  CN: "Credit note",
};

export function DocChip({
  kind,
  number,
  tone = "idle",
  title,
  className = "",
}: {
  kind: DocKind;
  number: string;
  tone?: Tone;
  title?: string;
  className?: string;
}) {
  return (
    <span className={`chip tone-${tone} ${className}`} title={title ?? `${KIND_NAME[kind]} ${number}`}>
      <b>{kind}</b>
      <span className="chip-sep" aria-hidden="true">·</span>
      <span className="chip-no">{number}</span>
    </span>
  );
}

/** A status in words — UPPERCASE, flat, optionally with a dot. Never clickable. */
export function StatusBadge({
  tone,
  dot = false,
  title,
  className = "",
  children,
}: {
  tone: Tone;
  dot?: boolean;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`status tone-${tone} ${className}`} title={title}>
      {dot && <span className="status-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** CR against an invoice, CO with none behind it, UPL for an uplift. */
export function collectionKind(c: { type: string; originalInvoiceNo?: string | null }): DocKind {
  if (c.type === "NON_CREDIT_UPLIFT") return "UPL";
  return c.originalInvoiceNo ? "CR" : "CO";
}

/** A delivery's tint: signed green, at the door amber, otherwise not started. */
export function invoiceTone(stopStatus: string): Tone {
  return stopStatus === "SIGNED" ? "green" : stopStatus === "IN_PROGRESS" ? "amber" : "idle";
}

/** A collection's tint: back violet, did not happen red, otherwise not started. */
export function collectionTone(status: string): Tone {
  if (status === "COLLECTED" || status === "PARTIAL") return "violet";
  if (status === "NOT_AVAILABLE" || status === "REFUSED") return "red";
  return "idle";
}

/** A credit note's tint, by its status on the Credits page. */
export function creditNoteTone(status: string): Tone {
  return status === "SIGNED" ? "blue" : status === "REJECTED" ? "red" : status === "NEEDS_REVIEW" ? "amber" : "green";
}
