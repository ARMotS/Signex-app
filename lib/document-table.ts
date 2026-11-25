/**
 * The product table shared by the client's credit notes and invoices. Both
 * come out of the same accounting system, so they print the same table:
 *
 *   Product no · (short name) · Bin · Description · Qty · Unit Price · Disc % · Nett
 *   618ABG   BATTERY   FLOOR   BATT BM-618B41LB1 41AH 360CCA   1   720.00   0   720.00
 *   Other: 618AB,,,,               Brand: UNITECH 12M WO        Uom: EACH
 *                                                 SUB TOTAL   720.00
 *
 * Moved here unchanged from lib/credit-note.ts so the invoice line reader
 * (lib/invoice-lines.ts) reads the table exactly as the credit note reader
 * does — tests/credit-note.test.ts still covers every rule. Pure.
 */

import type { TextItem } from "./invoice-header";
import { joinTouching, toCells, toRows, tokens, type Cell } from "./collection-sheet";

export interface TableLine {
  lineNo: number;
  productCode: string | null;
  shortName: string | null;
  bin: string | null;
  description: string;
  qty: number;
  unitPrice: number | null;
  discountPct: number | null;
  nett: number | null;
  /** From the follow-on row's "Uom: EACH"; null where the line prints none. */
  uom: string | null;
}

// ─── Numbers ──────────────────────────────────────────────────────────────

/**
 * An amount as printed: 720.00, 1,234.56, 1 234.56, R 828.00, 720,00, a
 * trailing or leading minus. Two decimals at most — "10.200" beside "W:" is
 * the parcel's weight, not money.
 */
export function parseAmount(raw: string): number | null {
  let t = raw.replace(/\s+/g, "").replace(/^R/i, "");
  const negative = /^-|-$/.test(t);
  t = t.replace(/^-|-$/g, "");
  if (/^\d+,\d{2}$/.test(t)) t = t.replace(",", "."); // decimal comma
  if (!/^\d{1,3}(?:,?\d{3})*(?:\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** A quantity: 1, 12, 2.5. A credit may print it negative; the count is what matters. */
export function parseQty(raw: string): number | null {
  const t = raw.trim().replace(/^-|-$/g, "");
  if (!/^\d{1,6}(?:\.\d{1,3})?$/.test(t)) return null;
  return Number(t);
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Table ────────────────────────────────────────────────────────────────

/** The follow-on row under each line on the client's note — not a line of its own. */
export const FOLLOW_ON = /^(other|brand|uom)\s*:/i;
export const SUBTOTAL_LABEL = /^sub\s*-?\s*total\b/i;
export const VAT_LABEL = /^(?:total\s+)?(?:vat|tax)\b/i;
export const TOTAL_LABEL = /^(?:grand\s+)?total\b(?!\s*(?:vat|tax))/i;
const isTotalsLabel = (text: string) => SUBTOTAL_LABEL.test(text) || VAT_LABEL.test(text) || TOTAL_LABEL.test(text);

export interface Columns {
  headerCy: number;
  binX: number | null;
  descX: number;
  qtyX: number;
  priceX: number | null;
  discX: number | null;
  nettX: number;
}

/** The heading row's positions, or null when the page has none we recognise. */
export function findColumns(rows: Cell[][]): Columns | null {
  for (const row of rows) {
    const words = row.flatMap(tokens);
    const at = (re: RegExp) => words.find((w) => re.test(w.text))?.x ?? null;
    const descX = at(/^description$/i);
    const qtyX = at(/^(qty|quantity)$/i);
    const nettX = at(/^(nett|net|amount|total)$/i);
    if (descX === null || qtyX === null || nettX === null || nettX <= qtyX) continue;
    return {
      headerCy: row[0].cy,
      binX: at(/^bin$/i),
      descX,
      qtyX,
      priceX: at(/^(unit|price)$/i),
      discX: at(/^disc/i),
      nettX,
    };
  }
  return null;
}

/** The table's cells, and the Nett figure of each row in it. */
export function tableBody(cells: Cell[], cols: Columns): { body: Cell[]; anchors: Cell[]; nettFrom: number } {
  const nettFrom = cols.nettX - 15;
  const below = cells.filter((c) => c.cy > cols.headerCy + 3);
  // The table ends at the totals block.
  const totalsCy = Math.min(...below.filter((c) => isTotalsLabel(c.text)).map((c) => c.cy), Infinity);
  const body = below.filter((c) => c.cy < totalsCy - 3 && !FOLLOW_ON.test(c.text));
  const anchors = body.filter((c) => c.x >= nettFrom && parseAmount(c.text) !== null).sort((a, b) => a.cy - b.cy);
  return { body, anchors, nettFrom };
}

/** How far above and below its Nett figure a product line and its follow-on row reach. */
export const LINE_REACH_UP = 9;
export const LINE_REACH_DOWN = 20;

/**
 * The lines on one page. Each line is anchored on its Nett figure: every
 * other cell within a few points of it vertically belongs to it (the product
 * no and Qty print in a larger size, on a lower baseline). The follow-on
 * "Other: / Brand: / Uom:" row sits further down and joins nothing.
 */
export function readTable(items: TextItem[]): TableLine[] {
  const cells = toCells(items);
  const cols = findColumns(toRows(cells));
  if (!cols) return [];

  // Figures are right-aligned under their headings, so each zone opens a
  // little before its heading.
  const { body, anchors, nettFrom } = tableBody(cells, cols);
  const figuresFrom = cols.qtyX - 25;
  const priceFrom = cols.priceX !== null ? cols.priceX - 5 : null;
  const discFrom = cols.discX !== null ? cols.discX - 5 : null;
  const zoneOf = (x: number): "text" | "qty" | "price" | "disc" | "nett" => {
    if (x < figuresFrom) return "text";
    if (x >= nettFrom) return "nett";
    if (discFrom !== null && x >= discFrom) return "disc";
    if (priceFrom !== null && x >= priceFrom) return "price";
    return "qty";
  };

  if (anchors.length === 0) return [];

  // On the client's note the Qty sits ~4pt from its line's Nett and the
  // follow-on row 12pt+ below it; lines are 25pt apart. A window of 9pt —
  // never more than half-way to the next line — takes the one, not the other.
  const reach = anchors.map((a, i) =>
    Math.min(9, ...[anchors[i - 1], anchors[i + 1]].filter(Boolean).map((n) => Math.abs(n.cy - a.cy) / 2))
  );
  const members: Cell[][] = anchors.map(() => []);
  for (const c of body) {
    if (anchors.includes(c)) continue;
    let best = -1;
    let bestDy = Infinity;
    anchors.forEach((a, i) => {
      const dy = Math.abs(c.cy - a.cy);
      if (dy < bestDy) [best, bestDy] = [i, dy];
    });
    if (best >= 0 && bestDy <= reach[best]) members[best].push(c);
  }

  const lines: TableLine[] = [];
  const uoms = readUoms(cells, cols, anchors);
  anchors.forEach((anchor, i) => {
    const row = members[i].sort((a, b) => a.x - b.x);
    const figure = (zone: string) => row.filter((c) => zoneOf(c.x) === zone).flatMap(tokens);
    const qty = figure("qty").map((t) => parseQty(t.text)).find((n) => n !== null) ?? null;
    if (qty === null) return; // a comment row with an amount, not a product line

    const textCells = row.filter(
      (c) => zoneOf(c.x) === "text" || !c.text.split(/\s+/).every((w) => parseAmount(w) !== null || parseQty(w) !== null)
    );
    // A bin can print a little left of its heading (CR-407710: 17G2 at 192.8
    // under Bin at 199.5); the short name ends well before either.
    const codeEnd = cols.binX !== null ? cols.binX - 12 : cols.descX - 5;
    const lead = joinTouching(textCells.filter((c) => c.x < codeEnd));
    const bin = joinTouching(textCells.filter((c) => c.x >= codeEnd && c.x < cols.descX - 5));
    const desc = joinTouching(textCells.filter((c) => c.x >= cols.descX - 5));
    const productCode = lead[0]?.text ?? null;
    const shortName = lead.slice(1).map((c) => c.text).join(" ") || null;
    const description = desc.map((c) => c.text).join(" ").trim();

    lines.push({
      lineNo: 0,
      productCode,
      shortName,
      bin: cols.binX !== null ? bin.map((c) => c.text).join(" ") || null : null,
      description: description || shortName || productCode || "",
      qty,
      unitPrice: figure("price").map((t) => parseAmount(t.text)).find((n) => n !== null) ?? null,
      discountPct: figure("disc").map((t) => parseAmount(t.text.replace(/%$/, ""))).find((n) => n !== null) ?? null,
      nett: Math.abs(parseAmount(anchor.text)!),
      uom: uoms[i],
    });
  });
  return lines;
}

/** The value printed beside a totals label — inline, or the nearest amount to its right. */
export function amountBeside(cells: Cell[], label: RegExp): number | null {
  const hits = cells.filter((c) => label.test(c.text)).sort((a, b) => b.cy - a.cy);
  for (const hit of hits) {
    const inline = hit.text.replace(label, "").replace(/^[\s:]+/, "");
    const inlineValue = inline ? parseAmount(inline.split(/\s+(?=R?\s?-?\d)/).pop() ?? "") : null;
    if (inlineValue !== null) return Math.abs(inlineValue);
    const beside = cells
      .filter(
        (c) =>
          c.x > hit.right &&
          Math.abs(c.cy - hit.cy) <= Math.max(c.height, hit.height) * 0.6 &&
          parseAmount(c.text) !== null
      )
      .sort((a, b) => a.x - b.x)[0];
    if (beside) return Math.abs(parseAmount(beside.text)!);
  }
  return null;
}

const UOM_LABEL = /^uom\s*:\s*/i;

/**
 * Each line's unit of measure, from the follow-on row printed under it
 * ("Uom: EACH" — the label and its value arrive as separate runs). The row
 * belongs to the nearest line above it, within that row's reach.
 */
function readUoms(cells: Cell[], cols: Columns, anchors: Cell[]): (string | null)[] {
  const out: (string | null)[] = anchors.map(() => null);
  for (const label of cells.filter((c) => c.cy > cols.headerCy + 3 && UOM_LABEL.test(c.text))) {
    const inline = label.text.replace(UOM_LABEL, "").trim();
    const value =
      inline ||
      cells
        .filter((c) => c.x > label.right && c.x - label.right < 60 && Math.abs(c.cy - label.cy) <= Math.max(c.height, label.height) * 0.8)
        .sort((a, b) => a.x - b.x)[0]?.text.trim() ||
      "";
    if (!value) continue;
    let owner = -1;
    anchors.forEach((a, i) => {
      if (a.cy < label.cy && label.cy - a.cy <= LINE_REACH_DOWN) owner = i;
    });
    if (owner >= 0 && out[owner] === null) out[owner] = value.slice(0, 20);
  }
  return out;
}

export interface DocumentTotals {
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
}

/** The totals block, from the last page that prints one. */
export function readTotals(pages: TextItem[][]): DocumentTotals {
  for (const page of [...pages].reverse()) {
    const cells = toCells(page);
    const found = {
      subtotal: amountBeside(cells, SUBTOTAL_LABEL),
      vatAmount: amountBeside(cells, VAT_LABEL),
      total: amountBeside(cells, TOTAL_LABEL),
    };
    if (found.subtotal !== null || found.total !== null) return found;
  }
  return { subtotal: null, vatAmount: null, total: null };
}
