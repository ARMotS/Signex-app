/**
 * Confirm-by-exception: what the driver records at the door when the office's
 * sheet has been read into lines.
 *
 * The sheet is the source of truth for what should come back. The driver does
 * not pick items; they confirm the sheet in one tap, or record only what
 * differs, or say why nothing could be collected:
 *
 *   AS_LISTED      every line came back as listed           → COLLECTED
 *   NOT_AS_LISTED  counts adjusted, reasons, extra items    → PARTIAL if fewer
 *                                                             came back, else
 *                                                             COLLECTED; flagged
 *   FAILED         a reason, no signature                   → REFUSED when the
 *                                                             customer refused,
 *                                                             else NOT_AVAILABLE
 *
 * The existing statuses are kept because accounts acts on them (a credit for a
 * full or a short return, try again, raise nothing); hasVariance and the line
 * reasons say what happened.
 *
 * Pure — no database, no I/O — so the route and the tests share one rulebook.
 */

export const DIFF_REASONS = ["SHORT", "DAMAGED", "NOT_AVAILABLE", "CUSTOMER_KEPT", "OTHER"] as const;
export type DiffReason = (typeof DIFF_REASONS)[number];

export const DIFF_REASON_LABEL: Record<DiffReason, string> = {
  SHORT: "Short",
  DAMAGED: "Damaged",
  NOT_AVAILABLE: "Not available",
  CUSTOMER_KEPT: "Customer kept",
  OTHER: "Other",
};

export const FAIL_REASONS = ["CUSTOMER_NOT_READY", "GOODS_NOT_AVAILABLE", "CUSTOMER_REFUSED", "OTHER"] as const;
export type FailReason = (typeof FAIL_REASONS)[number];

export const FAIL_REASON_LABEL: Record<FailReason, string> = {
  CUSTOMER_NOT_READY: "Customer not ready",
  GOODS_NOT_AVAILABLE: "Goods not available",
  CUSTOMER_REFUSED: "Customer refused",
  OTHER: "Other",
};

export type ConfirmMode = "AS_LISTED" | "NOT_AS_LISTED" | "FAILED";

export interface ListedLine {
  lineNo: number;
  description: string;
  qtyListed: number;
}

export interface ConfirmInput {
  mode: ConfirmMode;
  /** NOT_AS_LISTED: the count per line. A line left out came back as listed. */
  lines?: { lineNo: number; qtyCollected: number; diffReason?: string | null; diffNote?: string | null }[];
  /** NOT_AS_LISTED: handed over but not on the sheet. */
  extras?: { description: string; qty: number }[];
  failReason?: string | null;
  failNote?: string | null;
}

export interface LineUpdate {
  lineNo: number;
  qtyCollected: number;
  diffReason: DiffReason | null;
  diffNote: string | null;
}

export type Confirmation =
  | {
      ok: true;
      status: "COLLECTED" | "PARTIAL" | "NOT_AVAILABLE" | "REFUSED";
      /** Required by the existing outcome rules for anything but COLLECTED. */
      exceptionReason: string | null;
      hasVariance: boolean;
      failReason: FailReason | null;
      /** Whether the customer signs: something changed hands. */
      needsSignature: boolean;
      lineUpdates: LineUpdate[];
      extras: { description: string; qty: number }[];
      /** Items that came back, lines and extras together. */
      collectedItems: number;
      listedItems: number;
    }
  | { ok: false; error: string };

export const MAX_EXTRAS = 20;
const NOTE_MAX = 300;
const DESCRIPTION_MAX = 120;

const clean = (s: string | null | undefined, max: number) => {
  const v = String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  return v || null;
};

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function resolveConfirmation(listed: ListedLine[], input: ConfirmInput): Confirmation {
  const listedItems = listed.reduce((n, l) => n + l.qtyListed, 0);

  if (input.mode === "FAILED") {
    const failReason = input.failReason as FailReason;
    if (!FAIL_REASONS.includes(failReason)) {
      return { ok: false, error: "Say why the collection failed" };
    }
    const note = clean(input.failNote, NOTE_MAX);
    if (failReason === "OTHER" && !note) {
      return { ok: false, error: "Describe what happened" };
    }
    return {
      ok: true,
      status: failReason === "CUSTOMER_REFUSED" ? "REFUSED" : "NOT_AVAILABLE",
      exceptionReason: note ? `${FAIL_REASON_LABEL[failReason]}: ${note}` : FAIL_REASON_LABEL[failReason],
      hasVariance: false,
      failReason,
      needsSignature: false,
      lineUpdates: listed.map((l) => ({ lineNo: l.lineNo, qtyCollected: 0, diffReason: null, diffNote: null })),
      extras: [],
      collectedItems: 0,
      listedItems,
    };
  }

  if (input.mode === "AS_LISTED") {
    return {
      ok: true,
      status: "COLLECTED",
      exceptionReason: null,
      hasVariance: false,
      failReason: null,
      needsSignature: true,
      lineUpdates: listed.map((l) => ({ lineNo: l.lineNo, qtyCollected: l.qtyListed, diffReason: null, diffNote: null })),
      extras: [],
      collectedItems: listedItems,
      listedItems,
    };
  }

  if (input.mode !== "NOT_AS_LISTED") {
    return { ok: false, error: "Choose Collected as listed, Not as listed or Collection failed" };
  }

  const byLine = new Map((input.lines ?? []).map((l) => [l.lineNo, l]));
  for (const lineNo of byLine.keys()) {
    if (!listed.some((l) => l.lineNo === lineNo)) {
      return { ok: false, error: `Line ${lineNo} is not on this collection's sheet` };
    }
  }

  const lineUpdates: LineUpdate[] = [];
  const summary: string[] = [];
  for (const line of listed) {
    const given = byLine.get(line.lineNo);
    const qty = given ? given.qtyCollected : line.qtyListed;
    if (!isCount(qty) || qty > line.qtyListed) {
      return {
        ok: false,
        error: `Line ${line.lineNo}: the count must be a whole number from 0 to ${line.qtyListed}`,
      };
    }
    const reason = given?.diffReason ? (given.diffReason as DiffReason) : null;
    if (reason && !DIFF_REASONS.includes(reason)) {
      return { ok: false, error: `Line ${line.lineNo}: that reason is not recognised` };
    }
    if (qty < line.qtyListed && !reason) {
      return { ok: false, error: `Line ${line.lineNo}: say why fewer came back` };
    }
    const note = clean(given?.diffNote, NOTE_MAX);
    if (reason === "OTHER" && !note) {
      return { ok: false, error: `Line ${line.lineNo}: describe what happened` };
    }
    lineUpdates.push({ lineNo: line.lineNo, qtyCollected: qty, diffReason: reason, diffNote: note });
    if (qty < line.qtyListed || reason) {
      summary.push(
        `${line.description}: ${qty} of ${line.qtyListed}${reason ? ` (${DIFF_REASON_LABEL[reason]}${note ? ` — ${note}` : ""})` : ""}`
      );
    }
  }

  const extras: { description: string; qty: number }[] = [];
  for (const extra of input.extras ?? []) {
    const description = clean(extra.description, DESCRIPTION_MAX);
    if (!description) return { ok: false, error: "Describe each extra item" };
    if (!isCount(extra.qty) || extra.qty < 1) {
      return { ok: false, error: `"${description}": the count must be a whole number of 1 or more` };
    }
    extras.push({ description, qty: extra.qty });
    summary.push(`Extra, not on the sheet: ${extra.qty} × ${description}`);
  }
  if (extras.length > MAX_EXTRAS) {
    return { ok: false, error: `No more than ${MAX_EXTRAS} extra items` };
  }

  if (summary.length === 0) {
    return { ok: false, error: "Nothing differs from the sheet — use Collected as listed" };
  }

  const fromLines = lineUpdates.reduce((n, l) => n + l.qtyCollected, 0);
  const collectedItems = fromLines + extras.reduce((n, e) => n + e.qty, 0);
  if (collectedItems === 0) {
    return { ok: false, error: "Nothing came back — use Collection failed" };
  }

  return {
    ok: true,
    // Short against the sheet is PARTIAL whatever extras came with it: an
    // extra item is not the item the credit is for.
    status: fromLines < listedItems ? "PARTIAL" : "COLLECTED",
    exceptionReason: summary.join("; "),
    hasVariance: true,
    failReason: null,
    needsSignature: true,
    lineUpdates,
    extras,
    collectedItems,
    listedItems,
  };
}

/** The declaration printed above the customer's signature on the receipt. */
export const DEFAULT_COLLECTION_DECLARATION =
  "The goods above were collected in the quantity and condition stated. Any credit is subject to " +
  "inspection and approval by {companyName}. This note is not a credit note.";

export function collectionDeclaration(template: string | null | undefined, companyName: string): string {
  const text = (template && template.trim()) || DEFAULT_COLLECTION_DECLARATION;
  return text.replace(/\{companyName\}/g, companyName.trim() || "the company");
}
