/**
 * The rules for an invoice's lines typed in by the office — the review panel
 * (components/admin/InvoiceReviewPanel.tsx) and PUT
 * /api/invoice-records/[id]/lines run the same code, so Save is enabled
 * exactly when the server will accept it. No imports, so it runs in the
 * browser too.
 *
 * Quantities only (user decision, 2026-11-25): code, short name,
 * description, qty, unit. Nothing priced is accepted, even if sent.
 */

export const MAX_MANUAL_LINES = 300;
export const MANUAL_LINE_LIMITS = { itemCode: 60, shortName: 120, description: 500, uom: 20 } as const;
/** Fits Decimal(12, 3). */
export const MAX_LINE_QTY = 999_999_999;

export interface ManualLine {
  itemCode: string | null;
  shortName: string | null;
  description: string;
  qty: number;
  uom: string | null;
}

export interface ManualLineDraft {
  itemCode?: unknown;
  shortName?: unknown;
  description?: unknown;
  qty?: unknown;
  uom?: unknown;
}

export type ManualLinesResult =
  | { ok: true; lines: ManualLine[] }
  | { ok: false; error: string; /** 1-based, the line the error is about. */ line?: number };

const text = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** "2", "2.5", "2,5" (a South African keyboard) → a number; anything else → NaN. */
export function readLineQty(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const s = v.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

/**
 * Typed lines → lines to store, or the first thing wrong with them. A row
 * left completely blank is dropped (the editor always offers an empty one);
 * a row with anything typed must have a description (or a code) and a
 * quantity above nought, to at most three decimals.
 */
export function readManualLines(input: unknown): ManualLinesResult {
  if (!Array.isArray(input)) return { ok: false, error: "Lines must be a list" };

  const lines: ManualLine[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = (input[i] ?? {}) as ManualLineDraft;
    const itemCode = text(raw.itemCode, MANUAL_LINE_LIMITS.itemCode);
    const shortName = text(raw.shortName, MANUAL_LINE_LIMITS.shortName);
    const description = text(raw.description, MANUAL_LINE_LIMITS.description);
    const uom = text(raw.uom, MANUAL_LINE_LIMITS.uom);
    const qtyBlank = raw.qty === null || raw.qty === undefined || (typeof raw.qty === "string" && !raw.qty.trim());
    if (!itemCode && !shortName && !description && !uom && qtyBlank) continue;

    const line = i + 1;
    if (!description && !itemCode) return { ok: false, error: `Line ${line} needs a description or a product code`, line };
    const qty = readLineQty(raw.qty);
    if (qtyBlank || !Number.isFinite(qty) || qty <= 0) {
      return { ok: false, error: `Line ${line} needs a quantity above 0`, line };
    }
    if (qty > MAX_LINE_QTY) return { ok: false, error: `Line ${line}'s quantity is too large`, line };
    if (Math.abs(Math.round(qty * 1000) - qty * 1000) > 1e-6) {
      return { ok: false, error: `Line ${line}'s quantity can have at most 3 decimals`, line };
    }
    lines.push({ itemCode, shortName, description: description ?? itemCode!, qty: Math.round(qty * 1000) / 1000, uom });
  }

  if (lines.length === 0) return { ok: false, error: "Add at least one line" };
  if (lines.length > MAX_MANUAL_LINES) return { ok: false, error: `An invoice can have at most ${MAX_MANUAL_LINES} lines` };
  return { ok: true, lines };
}
