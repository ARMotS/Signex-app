/**
 * Read a credit note off its PDF, check its figures, and match its lines to
 * what the driver collected.
 *
 * The client's credit notes come out of the same accounting system as its
 * invoices (CR-407712-C007H014), so they carry a text layer and are read by
 * POSITION, with no AI call:
 *
 *   Inv No. 384281
 *   CR NOTE 407712
 *   Account no   Order no   Order date   Branch   Invoice date
 *   C007H014     SCR        19/07/2024   C1       16/10/2026      ← the credit's date
 *   Product no · (short name) · Bin · Description · Qty · Unit Price · Disc % · Nett
 *   618ABG   BATTERY   FLOOR   BATT BM-618B41LB1 41AH 360CCA   1   720.00   0   720.00
 *   Other: 618AB,,,,               Brand: UNITECH 12M WO        Uom: EACH   ← ignored
 *                                                 SUB TOTAL   720.00
 *                                                 TOTAL VAT   108.00
 *                                                 TOTAL     R 828.00
 *
 * The note never prints a collection number: it names the INVOICE it
 * credits, and the collections are found through that invoice. Matching is on
 * QUANTITIES only — a return carries a handling charge, so a credit never
 * equals the invoice's price. The amounts are checked against the note's own
 * totals, which is what proves every line was read.
 *
 * Pure apart from the PDF extraction and the Claude call — the tests drive
 * readCreditNoteFromPages, checkCreditFigures, matchCreditLines and
 * assessCreditNote directly.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import {
  extractPageItems,
  firstLineUnder,
  parseInvoiceDate,
  readHeaderFromItems,
  segmentLines,
  textBeside,
  type TextItem,
} from "./invoice-header";
import { joinTouching, toCells, toRows, tokens, type Cell } from "./collection-sheet";
import { customerMismatch } from "./invoice-registry";

export interface CreditLineRead {
  lineNo: number;
  productCode: string | null;
  shortName: string | null;
  bin: string | null;
  description: string;
  qty: number;
  unitPrice: number | null;
  discountPct: number | null;
  nett: number | null;
}

export interface ParsedCreditNote {
  creditNo: string | null;
  /** The invoice credited, as printed. */
  invoiceNo: string | null;
  /** YYYY-MM-DD — the note's own date, never the Order date beside it. */
  creditDate: string | null;
  accountNo: string | null;
  deliverToName: string | null;
  billToName: string | null;
  lines: CreditLineRead[];
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
}

export interface CreditIssue {
  code: string;
  /** "review" puts the note in NEEDS_REVIEW; "warning" is shown but it stays RECEIVED. */
  level: "review" | "warning";
  message: string;
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
function parseQty(raw: string): number | null {
  const t = raw.trim().replace(/^-|-$/g, "");
  if (!/^\d{1,6}(?:\.\d{1,3})?$/.test(t)) return null;
  return Number(t);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─── Header ───────────────────────────────────────────────────────────────

const INVOICE_REF_LABELS = [
  "inv no",
  "inv. no",
  "invoice no",
  "invoice number",
  "original invoice",
  "against invoice",
  "invoice ref",
];
const ACCOUNT_LABELS = ["account no", "account number", "acc no"];
const HEADER_LABELS = [
  ...ACCOUNT_LABELS,
  "order no",
  "order date",
  "branch",
  "invoice date",
  "invoice to",
  "deliver to",
  "customer vat no",
];

/** "CR NOTE 407712", "CREDIT NOTE No. CN-407712", "Credit Note: 407712". */
const CREDIT_TITLE = /\b(?:CR|CREDIT)\.?\s*NOTE\b\s*(?:NO\.?|NUMBER|#)?\s*:?\s*([A-Z]{0,4}-?\d[\d-]*)?/i;
const DOC_NUMBER = /^[A-Z]{0,4}-?\d[\d-]*$/i;

function readCreditNumber(items: TextItem[]): string | null {
  const lines = segmentLines(items);
  for (const row of lines) {
    for (const seg of row) {
      const m = seg.text.match(CREDIT_TITLE);
      if (!m) continue;
      if (m[1]) return m[1];
      // The number in its own run beside the title, as on the client's note.
      const beside = row
        .filter((s) => s.x > seg.right && s.x - seg.right < 200 && DOC_NUMBER.test(s.text))
        .sort((a, b) => a.x - b.x)[0];
      if (beside) return beside.text;
    }
  }
  return null;
}

function readInvoiceRef(items: TextItem[]): string | null {
  const value = textBeside(segmentLines(items), INVOICE_REF_LABELS);
  return value?.match(/[A-Z]{0,6}[-/]?\d[\d\-/]*/i)?.[0] ?? null;
}

// ─── Table ────────────────────────────────────────────────────────────────

/** The follow-on row under each line on the client's note — not a line of its own. */
const FOLLOW_ON = /^(other|brand|uom)\s*:/i;
const SUBTOTAL_LABEL = /^sub\s*-?\s*total\b/i;
const VAT_LABEL = /^(?:total\s+)?(?:vat|tax)\b/i;
const TOTAL_LABEL = /^(?:grand\s+)?total\b(?!\s*(?:vat|tax))/i;
const isTotalsLabel = (text: string) => SUBTOTAL_LABEL.test(text) || VAT_LABEL.test(text) || TOTAL_LABEL.test(text);

interface Columns {
  headerCy: number;
  binX: number | null;
  descX: number;
  qtyX: number;
  priceX: number | null;
  discX: number | null;
  nettX: number;
}

/** The heading row's positions, or null when the page has none we recognise. */
function findColumns(rows: Cell[][]): Columns | null {
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

/**
 * The lines on one page. Each line is anchored on its Nett figure: every
 * other cell within a few points of it vertically belongs to it (the product
 * no and Qty print in a larger size, on a lower baseline). The follow-on
 * "Other: / Brand: / Uom:" row sits further down and joins nothing.
 */
function readTable(items: TextItem[]): CreditLineRead[] {
  const cells = toCells(items);
  const cols = findColumns(toRows(cells));
  if (!cols) return [];

  // Figures are right-aligned under their headings, so each zone opens a
  // little before its heading.
  const figuresFrom = cols.qtyX - 25;
  const priceFrom = cols.priceX !== null ? cols.priceX - 5 : null;
  const discFrom = cols.discX !== null ? cols.discX - 5 : null;
  const nettFrom = cols.nettX - 15;
  const zoneOf = (x: number): "text" | "qty" | "price" | "disc" | "nett" => {
    if (x < figuresFrom) return "text";
    if (x >= nettFrom) return "nett";
    if (discFrom !== null && x >= discFrom) return "disc";
    if (priceFrom !== null && x >= priceFrom) return "price";
    return "qty";
  };

  const below = cells.filter((c) => c.cy > cols.headerCy + 3);
  // The table ends at the totals block.
  const totalsCy = Math.min(...below.filter((c) => isTotalsLabel(c.text)).map((c) => c.cy), Infinity);
  const body = below.filter((c) => c.cy < totalsCy - 3 && !FOLLOW_ON.test(c.text));

  const anchors = body
    .filter((c) => zoneOf(c.x) === "nett" && parseAmount(c.text) !== null)
    .sort((a, b) => a.cy - b.cy);
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

  const lines: CreditLineRead[] = [];
  anchors.forEach((anchor, i) => {
    const row = members[i].sort((a, b) => a.x - b.x);
    const figure = (zone: string) => row.filter((c) => zoneOf(c.x) === zone).flatMap(tokens);
    const qty = figure("qty").map((t) => parseQty(t.text)).find((n) => n !== null) ?? null;
    if (qty === null) return; // a comment row with an amount, not a product line

    const textCells = row.filter(
      (c) => zoneOf(c.x) === "text" || !c.text.split(/\s+/).every((w) => parseAmount(w) !== null || parseQty(w) !== null)
    );
    const codeEnd = (cols.binX ?? cols.descX) - 5;
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
    });
  });
  return lines;
}

/** The value printed beside a totals label — inline, or the nearest amount to its right. */
function amountBeside(cells: Cell[], label: RegExp): number | null {
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

/** The note from its pages' text items. Pure — see tests/credit-note.test.ts. */
export function readCreditNoteFromPages(pages: TextItem[][]): ParsedCreditNote {
  const first = pages[0] ?? [];
  const header = readHeaderFromItems(first);
  const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

  const lines: CreditLineRead[] = [];
  for (const page of pages) lines.push(...readTable(page));
  lines.forEach((l, i) => (l.lineNo = i + 1));

  // Totals sit on the last page that prints them.
  let totals = { subtotal: null as number | null, vatAmount: null as number | null, total: null as number | null };
  for (const page of [...pages].reverse()) {
    const cells = toCells(page);
    const found = {
      subtotal: amountBeside(cells, SUBTOTAL_LABEL),
      vatAmount: amountBeside(cells, VAT_LABEL),
      total: amountBeside(cells, TOTAL_LABEL),
    };
    if (found.subtotal !== null || found.total !== null) {
      totals = found;
      break;
    }
  }

  return {
    creditNo: readCreditNumber(first),
    invoiceNo: readInvoiceRef(first),
    creditDate: header.invoiceDate ? header.invoiceDate.toISOString().slice(0, 10) : null,
    accountNo: blank(firstLineUnder(segmentLines(first), ACCOUNT_LABELS, HEADER_LABELS)),
    deliverToName: blank(header.deliverToName),
    billToName: blank(header.billToName),
    lines,
    ...totals,
  };
}

// ─── Scans ────────────────────────────────────────────────────────────────

const NOTE_SCHEMA = {
  type: "object",
  properties: {
    creditNo: { type: "string", description: 'The credit note number, or "".' },
    invoiceNo: { type: "string", description: 'The invoice number the credit is against, or "".' },
    creditDate: { type: "string", description: 'The credit note\'s own date as YYYY-MM-DD (not the order date), or "".' },
    accountNo: { type: "string", description: 'The customer account number, or "".' },
    deliverToName: { type: "string", description: 'First line of the "Deliver to" block, or "".' },
    billToName: { type: "string", description: 'First line of the "Invoice to" block, or "".' },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productCode: { type: "string", description: 'The product number, or "".' },
          description: { type: "string" },
          qty: { type: "number" },
          unitPrice: { type: "number" },
          discountPct: { type: "number" },
          nett: { type: "number" },
        },
        required: ["productCode", "description", "qty", "unitPrice", "discountPct", "nett"],
        additionalProperties: false,
      },
    },
    subtotal: { type: "number", description: "The sub total before VAT, or -1 if not printed." },
    vatAmount: { type: "number", description: "The VAT amount, or -1 if not printed." },
    total: { type: "number", description: "The total including VAT, or -1 if not printed." },
  },
  required: ["creditNo", "invoiceNo", "creditDate", "accountNo", "deliverToName", "billToName", "lines", "subtotal", "vatAmount", "total"],
  additionalProperties: false,
} as const;

/**
 * Read a scanned credit note. Structured output, not a forced tool call: the
 * current model rejects forced tool_choice, and a JSON-schema response gives
 * the same guarantee of well-formed fields.
 */
export async function readCreditNoteWithClaude(pdf: Buffer): Promise<ParsedCreditNote> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 8000,
    output_config: { effort: "low", format: jsonSchemaOutputFormat(NOTE_SCHEMA) },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") },
          },
          {
            type: "text",
            text:
              "This is a credit note from a South African wholesaler. Read its header and every line " +
              "of its table, on every page, and its totals. Ignore the Other/Brand/Uom row under each " +
              "line. Amounts as positive numbers. Dates are day-first.",
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Credit note not read (${response.stop_reason ?? "no output"})`);
  }
  const out = response.parsed_output;
  console.info(
    `[credit-note] Claude read a scanned credit note: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`
  );
  const blank = (v: string) => v.trim() || null;
  const amount = (n: number) => (n >= 0 ? round2(n) : null);
  return {
    creditNo: blank(out.creditNo),
    invoiceNo: blank(out.invoiceNo),
    creditDate: parseInvoiceDate(out.creditDate)?.toISOString().slice(0, 10) ?? null,
    accountNo: blank(out.accountNo),
    deliverToName: blank(out.deliverToName),
    billToName: blank(out.billToName),
    lines: out.lines
      .filter((l) => l.description.trim() && l.qty > 0)
      .map((l, i) => ({
        lineNo: i + 1,
        productCode: blank(l.productCode),
        shortName: null,
        bin: null,
        description: l.description.trim(),
        qty: Math.abs(l.qty),
        unitPrice: amount(l.unitPrice),
        discountPct: amount(l.discountPct),
        nett: amount(l.nett),
      })),
    subtotal: amount(out.subtotal),
    vatAmount: amount(out.vatAmount),
    total: amount(out.total),
  };
}

/** Fewer characters than this on page one: treat the PDF as a scan. */
const MIN_TEXT_LAYER_CHARS = 20;

export async function readCreditNote(
  pdf: Buffer
): Promise<{ note: ParsedCreditNote; source: "TEXT" | "AI" }> {
  const pages = await extractPageItems(pdf, 10);
  const chars = (pages[0] ?? []).reduce((n, i) => n + i.str.trim().length, 0);

  if (chars >= MIN_TEXT_LAYER_CHARS) {
    const note = readCreditNoteFromPages(pages);
    // Lines but no credit number is a document that is not a credit note (an
    // invoice saved into the wrong folder) — review, not a Claude call that
    // cannot find a number that is not there.
    if (note.lines.length > 0) return { note, source: "TEXT" };
    // A text layer with no table we recognise is a layout we do not know,
    // not a scan — Claude reads it rather than leaving it empty.
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("The credit note could not be read, and ANTHROPIC_API_KEY is not set for the scanned-PDF fallback");
  }
  return { note: await readCreditNoteWithClaude(pdf), source: "AI" };
}

// ─── The note's own figures ───────────────────────────────────────────────

/**
 * Do the note's figures add up? A line total off by more than a cent means a
 * line was misread; lines that do not add up to the sub total mean one was
 * missed. Each line is tried both ways the client's system rounds: the
 * discounted unit price rounded first, or the line rounded once.
 */
export function checkCreditFigures(note: ParsedCreditNote, vatRate: number): CreditIssue[] {
  const issues: CreditIssue[] = [];
  const money = (n: number) => n.toFixed(2);

  for (const line of note.lines) {
    if (line.unitPrice === null || line.nett === null) continue;
    const disc = (line.discountPct ?? 0) / 100;
    const perUnit = round2(round2(line.unitPrice * (1 - disc)) * line.qty);
    const once = round2(line.unitPrice * line.qty * (1 - disc));
    if (Math.abs(perUnit - line.nett) > 0.011 && Math.abs(once - line.nett) > 0.011) {
      issues.push({
        code: "LINE_AMOUNT",
        level: "warning",
        message: `Line ${line.lineNo}: ${line.qty} × ${money(line.unitPrice)}${line.discountPct ? ` less ${line.discountPct}%` : ""} is not ${money(line.nett)}.`,
      });
    }
  }

  const lineSum = round2(note.lines.reduce((s, l) => s + (l.nett ?? 0), 0));
  const allPriced = note.lines.length > 0 && note.lines.every((l) => l.nett !== null);

  if (note.subtotal === null && note.total === null) {
    issues.push({
      code: "TOTALS_UNREAD",
      level: "review",
      message: "The note's totals could not be read, so there is no check that every line was read.",
    });
    return issues;
  }

  if (note.subtotal !== null && allPriced && Math.abs(lineSum - note.subtotal) > 0.015) {
    issues.push({
      code: "LINES_TOTAL",
      level: "review",
      message: `The lines add up to ${money(lineSum)}, but the sub total is ${money(note.subtotal)} — a line may have been missed or misread.`,
    });
  }

  const base = note.subtotal ?? (allPriced ? lineSum : null);
  if (base !== null && note.vatAmount !== null) {
    // VAT rounded per line drifts by up to a cent a line.
    const tolerance = Math.max(0.05, note.lines.length * 0.01);
    if (Math.abs(round2(base * vatRate) - note.vatAmount) > tolerance) {
      issues.push({
        code: "VAT_MISMATCH",
        level: "warning",
        message: `VAT of ${money(note.vatAmount)} is not ${Math.round(vatRate * 1000) / 10}% of ${money(base)}.`,
      });
    }
  }
  if (base !== null && note.vatAmount !== null && note.total !== null && Math.abs(round2(base + note.vatAmount) - note.total) > 0.015) {
    issues.push({
      code: "TOTAL_MISMATCH",
      level: "review",
      message: `${money(base)} plus VAT ${money(note.vatAmount)} is not the total of ${money(note.total)}.`,
    });
  }
  return issues;
}

// ─── Matching to what was collected ───────────────────────────────────────

export interface CollectedLine {
  id: string;
  collectionId: string;
  collectionNo: string;
  itemCode: string | null;
  shortName: string | null;
  description: string;
  /** What the driver brought back. */
  qtyCollected: number;
  type: "CREDIT_RETURN" | "NON_CREDIT_UPLIFT";
}

export interface LineMatch {
  lineNo: number;
  qty: number;
  allocations: { collectionLineId: string; collectionNo: string; qty: number }[];
  /** Credited but not covered by anything collected (and not already credited). */
  uncoveredQty: number;
  status: "MATCHED" | "OVER" | "NOT_COLLECTED";
}

const codeKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const textKey = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * Which collected lines each credit line pays for.
 *
 * By product code first — the note and the collection sheet come out of the
 * same system — then by description. Quantities only. A collected line is
 * used up by earlier credit lines and by what other credit notes already
 * credited (`alreadyCredited`, by collection line id), so one return is never
 * credited twice. Uplifts (crates, parcels) are never credited.
 */
export function matchCreditLines(
  creditLines: Pick<CreditLineRead, "lineNo" | "productCode" | "shortName" | "description" | "qty">[],
  collected: CollectedLine[],
  alreadyCredited: Map<string, number> = new Map()
): LineMatch[] {
  const pool = collected.filter((c) => c.type === "CREDIT_RETURN");
  const left = new Map(pool.map((c) => [c.id, Math.max(0, c.qtyCollected - (alreadyCredited.get(c.id) ?? 0))]));

  return creditLines.map((line) => {
    const code = codeKey(line.productCode);
    const text = textKey(line.description);
    const byCode = code ? pool.filter((c) => codeKey(c.itemCode) === code || codeKey(c.shortName) === code) : [];
    const byText =
      byCode.length > 0 || text.length < 6
        ? []
        : pool.filter((c) => {
            const t = textKey(c.description);
            return t.length >= 6 && (t === text || t.includes(text) || text.includes(t));
          });
    const candidates = byCode.length > 0 ? byCode : byText;

    let need = line.qty;
    const allocations: LineMatch["allocations"] = [];
    for (const c of candidates) {
      const available = left.get(c.id) ?? 0;
      if (need <= 0 || available <= 0) continue;
      const take = Math.min(need, available);
      left.set(c.id, available - take);
      need = Math.round((need - take) * 1000) / 1000;
      allocations.push({ collectionLineId: c.id, collectionNo: c.collectionNo, qty: take });
    }

    return {
      lineNo: line.lineNo,
      qty: line.qty,
      allocations,
      uncoveredQty: need,
      status: need <= 0 ? "MATCHED" : candidates.length > 0 ? "OVER" : "NOT_COLLECTED",
    };
  });
}

// ─── Checking the note against the invoice and the collections ────────────

export interface CreditContext {
  vatRate: number;
  /** The registry row for the credited invoice; null when there is none. */
  invoice: { invoiceNo: string; customerName: string | null } | null;
  /** The collections this note pays for (AUTO or MANUAL links). */
  collections: { id: string; collectionNo: string; hasLines: boolean }[];
  /** Collections against the invoice the driver has not been to yet. */
  pendingCollectionNos: string[];
  collectedLines: CollectedLine[];
  alreadyCredited: Map<string, number>;
}

export interface CreditAssessment {
  status: "RECEIVED" | "NEEDS_REVIEW";
  issues: CreditIssue[];
  matches: LineMatch[];
}

export function assessCreditNote(
  note: ParsedCreditNote,
  ctx: CreditContext,
  source: "TEXT" | "AI"
): CreditAssessment {
  const issues: CreditIssue[] = [];
  const review = (code: string, message: string) => issues.push({ code, level: "review", message });
  const warn = (code: string, message: string) => issues.push({ code, level: "warning", message });

  if (!note.creditNo) review("CREDIT_NO_UNREAD", "The credit note number could not be read.");
  if (note.lines.length === 0) review("NO_LINES", "No lines could be read from the credit note.");
  issues.push(...checkCreditFigures(note, ctx.vatRate));

  if (!note.invoiceNo) {
    review("INVOICE_NO_UNREAD", "The invoice this note credits could not be read.");
  } else if (!ctx.invoice) {
    review("INVOICE_UNKNOWN", `Signex has no record of invoice ${note.invoiceNo}.`);
  }

  if (ctx.invoice && customerMismatch(ctx.invoice.customerName, note.deliverToName, note.billToName)) {
    warn(
      "CUSTOMER_MISMATCH",
      `The note is for ${note.deliverToName ?? note.billToName}; invoice ${ctx.invoice.invoiceNo} is for ${ctx.invoice.customerName}.`
    );
  }

  let matches: LineMatch[] = [];
  if (ctx.invoice && ctx.collections.length === 0) {
    if (ctx.pendingCollectionNos.length > 0) {
      review(
        "COLLECTION_PENDING",
        `Collection ${ctx.pendingCollectionNos.join(", ")} against invoice ${ctx.invoice.invoiceNo} has not been collected yet.`
      );
    } else {
      review("NO_COLLECTION", `Nothing has been collected against invoice ${ctx.invoice.invoiceNo}.`);
    }
  } else if (ctx.collections.length > 0) {
    const withoutLines = ctx.collections.filter((c) => !c.hasLines);
    for (const c of withoutLines) {
      warn(
        "NO_SHEET_LINES",
        `Collection ${c.collectionNo} was recorded without sheet lines, so its quantities cannot be checked.`
      );
    }
    if (withoutLines.length < ctx.collections.length) {
      matches = matchCreditLines(note.lines, ctx.collectedLines, ctx.alreadyCredited);
      for (const m of matches) {
        const line = note.lines.find((l) => l.lineNo === m.lineNo)!;
        const what = [line.productCode, line.description].filter(Boolean).join(" ");
        if (m.status === "NOT_COLLECTED" && withoutLines.length === 0) {
          review("NOT_COLLECTED", `Line ${m.lineNo} (${what}) was not on any collection against this invoice.`);
        } else if (m.status === "OVER") {
          review(
            "MORE_THAN_COLLECTED",
            `Line ${m.lineNo} (${what}) credits ${m.qty}, but only ${m.qty - m.uncoveredQty} came back and has not already been credited.`
          );
        }
      }

      // Collected but not credited by this note — a partial credit, or a line
      // the accounts office still has to raise.
      const credited = new Map<string, number>();
      for (const m of matches) for (const a of m.allocations) credited.set(a.collectionLineId, (credited.get(a.collectionLineId) ?? 0) + a.qty);
      for (const c of ctx.collectedLines) {
        if (c.type !== "CREDIT_RETURN" || c.qtyCollected <= 0) continue;
        const total = (ctx.alreadyCredited.get(c.id) ?? 0) + (credited.get(c.id) ?? 0);
        if (total < c.qtyCollected) {
          warn(
            "NOT_ALL_CREDITED",
            `${c.itemCode ?? c.description} on collection ${c.collectionNo}: ${c.qtyCollected} came back, ${total} credited.`
          );
        }
      }
    }
  }

  if (source === "AI") warn("READ_FROM_SCAN", "Read from a scan — check the lines against the note.");

  return {
    status: issues.some((i) => i.level === "review") ? "NEEDS_REVIEW" : "RECEIVED",
    issues,
    matches,
  };
}
