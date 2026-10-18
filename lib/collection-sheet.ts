/**
 * Read the office's collection sheet into lines — what the driver is expected
 * to bring back.
 *
 * The client's sheets come out of the same accounting system as its invoices,
 * so they carry a text layer and are read by POSITION, with no AI call:
 *
 *   CREDIT COLLECTION SHHET 001797
 *   Collection Address:          Account no       V002
 *   VISA AUTO ELECTRICAL         Invoice No.      130522
 *                                Collection date  25/11/2025
 *   Product no  ·  (short name)  ·  Description  ·  Qty  Returned  ·  Reason
 *   CABLE 7COR     CABLE 7COR 0.75  0.75MM 7COR…     1      0  1
 *
 * Each line prints on two baselines in two font sizes (product no and Qty a
 * few points lower), so rows are grouped by vertical CENTRE. "Qty Returned" is
 * one heading and the figures are right-aligned, so the numbers are read in
 * order, not by heading position: Qty (expected), Returned (as printed — 0 on
 * the office's copy; the driver's count is recorded at the door), then the
 * Reason code. Only a scan with no text layer goes to Claude.
 *
 * Pure apart from the PDF extraction and the Claude call — the tests drive
 * readSheetFromPages and assessSheet directly.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import {
  extractPageItems,
  firstLineUnder,
  parseInvoiceDate,
  segmentLines,
  textBeside,
  type TextItem,
} from "./invoice-header";
import { normalizeInvoiceNo, type InvoiceNoPattern } from "./invoice-number";
import { sameCollectionNumber } from "./collections";
import { customerMismatch } from "./invoice-registry";

export interface SheetLine {
  lineNo: number;
  itemCode: string | null;
  shortName: string | null;
  description: string;
  qtyListed: number;
  qtyReturnedPrinted: number | null;
  reasonCode: string | null;
}

export interface ParsedSheet {
  collectionNo: string | null;
  invoiceNo: string | null;
  customerName: string | null;
  accountNo: string | null;
  /** YYYY-MM-DD */
  collectionDate: string | null;
  lines: SheetLine[];
}

// ─── Header ───────────────────────────────────────────────────────────────

const CUSTOMER_LABELS = ["collection address", "collect from", "collection from", "customer"];
const INVOICE_LABELS = ["invoice no", "invoice number", "inv no", "original invoice", "invoice"];
const ACCOUNT_LABELS = ["account no", "account number", "acc no", "account"];
const DATE_LABELS = ["collection date", "date of collection"];
const NUMBER_LABELS = ["collection no", "collection number", "collection #"];
const HEADER_LABELS = [...CUSTOMER_LABELS, ...INVOICE_LABELS, ...ACCOUNT_LABELS, ...DATE_LABELS, ...NUMBER_LABELS, "page no"];

/**
 * "CREDIT COLLECTION SHHET 001797" — the number at the end of the title. A
 * letter prefix counts only when attached (CRCOL-1797), so a title word
 * before the number is never swallowed into it.
 */
const TITLE_NUMBER = /\bCOLLECTION\b.*?\b([A-Z]{0,6}-?\d[\d-]*)\s*$/i;

function readHeader(items: TextItem[]): Omit<ParsedSheet, "lines"> {
  const lines = segmentLines(items);
  const blank = (v: string | null) => (v && v.trim() ? v.trim() : null);

  let collectionNo = blank(textBeside(lines, NUMBER_LABELS));
  if (!collectionNo) {
    for (const seg of lines.flat()) {
      const m = seg.text.match(TITLE_NUMBER);
      if (m) {
        collectionNo = m[1].trim();
        break;
      }
    }
  }

  const date = textBeside(lines, DATE_LABELS);
  return {
    collectionNo,
    invoiceNo: blank(textBeside(lines, INVOICE_LABELS)),
    customerName: blank(firstLineUnder(lines, CUSTOMER_LABELS, HEADER_LABELS)),
    accountNo: blank(textBeside(lines, ACCOUNT_LABELS)),
    collectionDate: date ? parseInvoiceDate(date)?.toISOString().slice(0, 10) ?? null : null,
  };
}

// ─── Table ────────────────────────────────────────────────────────────────

/**
 * One run of text as the PDF drew it. The sheet's generator writes each cell
 * as its own run, so a run IS a cell — far more reliable than re-deriving
 * columns from the gaps between words, which close up whenever a cell is full.
 */
export interface Cell {
  text: string;
  x: number;
  right: number;
  /** Vertical centre — the two baselines of one line share it within a few points. */
  cy: number;
  height: number;
}

export function toCells(items: TextItem[]): Cell[] {
  return items
    .filter((item) => item.str.trim())
    .map((item) => {
      const perChar = item.width / Math.max(item.str.length, 1);
      const lead = item.str.length - item.str.trimStart().length;
      return {
        text: item.str.trim(),
        x: item.x + lead * perChar,
        right: item.x + item.width,
        cy: item.y + item.height / 2,
        height: item.height,
      };
    });
}

/** The words inside a cell, each with an estimated position. */
export function tokens(cell: Cell): { text: string; x: number }[] {
  const perChar = (cell.right - cell.x) / Math.max(cell.text.length, 1);
  return [...cell.text.matchAll(/\S+/g)].map((m) => ({ text: m[0], x: cell.x + (m.index ?? 0) * perChar }));
}

/**
 * Rows by vertical centre, top to bottom; cells in each row left to right.
 *
 * Chained: each cell is compared with the cell above it, not with the row's
 * first. One sheet line spans a small raised Reason digit, the 9pt
 * description and the 12pt product no / Qty — about 6pt from top to bottom —
 * while lines are 20pt apart.
 */
export function toRows(cells: Cell[]): Cell[][] {
  const rows: Cell[][] = [];
  let prev: Cell | null = null;
  for (const cell of [...cells].sort((a, b) => a.cy - b.cy)) {
    const row = rows[rows.length - 1];
    if (row && prev && cell.cy - prev.cy <= Math.max(4, Math.max(prev.height, cell.height) * 0.6)) row.push(cell);
    else rows.push([cell]);
    prev = cell;
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

const isInt = (s: string) => /^\d{1,6}$/.test(s);

/**
 * Runs that pdf.js split inside one cell — at a space, or with no gap at all —
 * joined back. A gap under about three-quarters of the text height is a space
 * inside a cell; the client's narrowest column gap is 14pt at 9pt text.
 */
export function joinTouching(cells: Cell[]): { x: number; text: string }[] {
  const out: { x: number; right: number; text: string; height: number }[] = [];
  for (const c of [...cells].sort((a, b) => a.x - b.x)) {
    const last = out[out.length - 1];
    const gap = last ? c.x - last.right : Infinity;
    if (last && gap < Math.max(1.5, Math.min(last.height, c.height) * 0.75)) {
      last.text += gap > 1.5 ? ` ${c.text}` : c.text;
      last.right = c.right;
    } else {
      out.push({ x: c.x, right: c.right, text: c.text, height: c.height });
    }
  }
  return out;
}

interface RawLine {
  textChunks: { x: number; text: string }[];
  ints: number[];
  reasonText: string;
}

/** The table on one page, or [] when the page has no recognisable heading. */
function readTable(items: TextItem[]): RawLine[] {
  const rows = toRows(toCells(items));
  const headerIndex = rows.findIndex((row) => {
    const words = row.flatMap(tokens);
    return words.some((w) => /^description$/i.test(w.text)) && words.some((w) => /^(qty|quantity)$/i.test(w.text));
  });
  if (headerIndex < 0) return [];

  const header = rows[headerIndex].flatMap(tokens);
  const qtyX = header.find((w) => /^(qty|quantity)$/i.test(w.text))!.x;
  const reasonX = header.find((w) => /^reason$/i.test(w.text))?.x ?? Infinity;
  // Figures are right-aligned under their headings, so the numeric zone opens
  // a little before "Qty" and closes a little before "Reason".
  const numericFrom = qtyX - 25;
  const reasonFrom = reasonX - 30;

  const lines: RawLine[] = [];
  let lastCy = rows[headerIndex][0].cy;
  for (const row of rows.slice(headerIndex + 1)) {
    const left = row.filter((c) => c.x < numericFrom);
    const middle = row.filter((c) => c.x >= numericFrom && c.x < reasonFrom);
    const reason = row.filter((c) => c.x >= reasonFrom);
    // Figures in order: Qty, Returned, then the Reason code.
    const ints = middle
      .flatMap(tokens)
      .filter((t) => isInt(t.text))
      .sort((a, b) => a.x - b.x)
      .map((t) => Number(t.text));
    // A description that runs into the numeric zone is still description.
    const overflow = middle.filter((c) => !c.text.split(/\s+/).every(isInt));
    const textCells = [...left, ...overflow];
    const gap = row[0].cy - lastCy;

    if (ints.length > 0 && textCells.length > 0) {
      lines.push({
        textChunks: joinTouching(textCells),
        ints,
        reasonText: reason.map((c) => c.text).join(" "),
      });
      lastCy = row[0].cy;
    } else if (lines.length > 0 && ints.length === 0 && textCells.length > 0 && gap < row[0].height * 1.8) {
      // A description wrapped onto a second line.
      const prev = lines[lines.length - 1];
      prev.textChunks.push(...joinTouching(textCells).map((c) => ({ ...c, x: Infinity })));
      lastCy = row[0].cy;
    } else if (lines.length > 0 || gap > 80) {
      break; // past the table: the footer, or nothing where lines should be
    }
  }
  return lines;
}

/**
 * Turn raw rows into lines. The text columns are found from where the runs
 * START across the whole table: the client's sheet has three (product no, an
 * unlabelled short name, description); another layout may have one or two.
 */
function toLines(raw: RawLine[], firstLineNo: number): SheetLine[] {
  const starts: number[] = [];
  for (const line of raw) {
    for (const c of line.textChunks) {
      if (c.x === Infinity) continue;
      if (!starts.some((s) => Math.abs(s - c.x) <= 15)) starts.push(c.x);
    }
  }
  starts.sort((a, b) => a - b);
  const columnOf = (x: number) =>
    x === Infinity
      ? starts.length - 1
      : starts.reduce((best, s, i) => (Math.abs(s - x) < Math.abs(starts[best] - x) ? i : best), 0);

  return raw.map((line, i) => {
    const columns: string[][] = starts.map(() => []);
    for (const c of line.textChunks) columns[columnOf(c.x)]?.push(c.text);
    const joined = columns.map((parts) => parts.join(" ").trim());

    let itemCode: string | null = null;
    let shortName: string | null = null;
    let description: string;
    if (joined.length >= 3) {
      [itemCode, shortName] = [joined[0] || null, joined[1] || null];
      description = joined.slice(2).join(" ").trim();
    } else if (joined.length === 2) {
      itemCode = joined[0] || null;
      description = joined[1];
    } else {
      description = joined[0] ?? "";
    }

    const [qty, returned, code] = line.ints;
    return {
      lineNo: firstLineNo + i,
      itemCode,
      shortName,
      description: description || shortName || itemCode || "",
      qtyListed: qty,
      qtyReturnedPrinted: returned ?? null,
      reasonCode: line.reasonText || (code !== undefined ? String(code) : null),
    };
  });
}

/** The sheet from its pages' text items. Pure — see tests/collection-sheet.test.ts. */
export function readSheetFromPages(pages: TextItem[][]): ParsedSheet {
  const header = readHeader(pages[0] ?? []);
  const lines: SheetLine[] = [];
  for (const page of pages) {
    lines.push(...toLines(readTable(page), lines.length + 1));
  }
  return { ...header, lines };
}

// ─── Scans ────────────────────────────────────────────────────────────────

const SHEET_SCHEMA = {
  type: "object",
  properties: {
    collectionNo: { type: "string", description: 'The collection sheet number, or "".' },
    invoiceNo: { type: "string", description: 'The invoice number the collection is against, or "".' },
    customerName: { type: "string", description: 'First line of the collection address (the customer), or "".' },
    accountNo: { type: "string", description: 'The account number, or "".' },
    collectionDate: { type: "string", description: 'The collection date as YYYY-MM-DD, or "".' },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          itemCode: { type: "string", description: 'The product number, or "".' },
          description: { type: "string" },
          qty: { type: "integer", description: "The Qty column: the count expected back." },
          reason: { type: "string", description: 'The Reason cell, or "".' },
        },
        required: ["itemCode", "description", "qty", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["collectionNo", "invoiceNo", "customerName", "accountNo", "collectionDate", "lines"],
  additionalProperties: false,
} as const;

/**
 * Read a scanned sheet. Structured output, not a forced tool call: the
 * current model rejects forced tool_choice, and a JSON-schema response gives
 * the same guarantee of well-formed fields. Nothing priced is asked for.
 */
export async function readSheetWithClaude(pdf: Buffer): Promise<ParsedSheet> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 8000,
    output_config: { effort: "low", format: jsonSchemaOutputFormat(SHEET_SCHEMA) },
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
              "This is a goods collection sheet from a South African wholesaler. Read its header " +
              "and every line of its table, on every page. The Qty column is the count expected back; " +
              "ignore the Returned column. Dates are day-first.",
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Sheet not read (${response.stop_reason ?? "no output"})`);
  }
  const out = response.parsed_output;
  console.info(
    `[collection-sheet] Claude read a scanned sheet: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`
  );
  const blank = (v: string) => v.trim() || null;
  return {
    collectionNo: blank(out.collectionNo),
    invoiceNo: blank(out.invoiceNo),
    customerName: blank(out.customerName),
    accountNo: blank(out.accountNo),
    collectionDate: parseInvoiceDate(out.collectionDate)?.toISOString().slice(0, 10) ?? null,
    lines: out.lines
      .filter((l) => l.description.trim() && l.qty >= 0)
      .map((l, i) => ({
        lineNo: i + 1,
        itemCode: blank(l.itemCode),
        shortName: null,
        description: l.description.trim(),
        qtyListed: l.qty,
        qtyReturnedPrinted: null,
        reasonCode: blank(l.reason),
      })),
  };
}

/** Fewer characters than this on page one: treat the PDF as a scan. */
const MIN_TEXT_LAYER_CHARS = 20;

export async function readCollectionSheet(
  pdf: Buffer
): Promise<{ sheet: ParsedSheet; source: "TEXT" | "AI" }> {
  const pages = await extractPageItems(pdf, 10);
  const chars = (pages[0] ?? []).reduce((n, i) => n + i.str.trim().length, 0);

  if (chars >= MIN_TEXT_LAYER_CHARS) {
    const sheet = readSheetFromPages(pages);
    if (sheet.lines.length > 0) return { sheet, source: "TEXT" };
    // A text layer with no table we recognise is a layout we do not know,
    // not a scan — Claude reads it rather than leaving the lines empty.
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("No lines could be read, and ANTHROPIC_API_KEY is not set for the scanned-sheet fallback");
  }
  return { sheet: await readSheetWithClaude(pdf), source: "AI" };
}

// ─── Checking it against the trip sheet row ───────────────────────────────

export interface SheetIssue {
  code: string;
  /** "review" puts the sheet in NEEDS_REVIEW; "warning" is shown but READY. */
  level: "review" | "warning";
  message: string;
}

export interface SheetExpectation {
  collectionNo: string;
  /** The trip sheet row's invoice, normalized; null for an ad hoc collection. */
  invoiceNoNormalized: string | null;
  customerName: string | null;
  /** The trip sheet marked this collection a non-credit uplift. */
  isUplift: boolean;
}

export interface SheetAssessment {
  status: "READY" | "NEEDS_REVIEW";
  issues: SheetIssue[];
  /** Every line's type: an uplift unless an invoice stands behind it. */
  lineType: "CREDIT_RETURN" | "NON_CREDIT_UPLIFT";
}

/**
 * Compare what the sheet says with what the trip sheet row says.
 *
 * No line total is compared with NOP: NOP counts BOXES, the lines count items
 * (four items in one box is not a mismatch).
 *
 * A sheet that names no invoice — and a row the trip sheet marks as an uplift
 * — is crates, parcels or documents: its lines are non-credit uplifts and are
 * never checked against an invoice.
 */
export function assessSheet(
  sheet: ParsedSheet,
  expected: SheetExpectation,
  source: "TEXT" | "AI",
  pattern: InvoiceNoPattern = null
): SheetAssessment {
  const issues: SheetIssue[] = [];
  const sheetInvoice = sheet.invoiceNo ? normalizeInvoiceNo(sheet.invoiceNo, pattern) || null : null;
  const lineType =
    !expected.isUplift && (sheetInvoice || expected.invoiceNoNormalized) ? "CREDIT_RETURN" : "NON_CREDIT_UPLIFT";

  if (sheet.lines.length === 0) {
    issues.push({ code: "NO_LINES", level: "review", message: "No lines could be read from the sheet." });
  }

  if (!sheet.collectionNo) {
    issues.push({
      code: "COLLECTION_NO_UNREAD",
      level: "review",
      message: `The sheet's collection number could not be read; the trip sheet row says ${expected.collectionNo}.`,
    });
  } else if (!sameCollectionNumber(sheet.collectionNo, expected.collectionNo)) {
    issues.push({
      code: "COLLECTION_NO_MISMATCH",
      level: "review",
      message: `The sheet is collection ${sheet.collectionNo}; the trip sheet row is ${expected.collectionNo}.`,
    });
  }

  if (lineType === "CREDIT_RETURN") {
    if (sheetInvoice && expected.invoiceNoNormalized && sheetInvoice !== expected.invoiceNoNormalized) {
      issues.push({
        code: "INVOICE_MISMATCH",
        level: "review",
        message: `The sheet is against invoice ${sheet.invoiceNo}; the trip sheet row names a different invoice.`,
      });
    } else if (sheetInvoice && !expected.invoiceNoNormalized) {
      issues.push({
        code: "INVOICE_ONLY_ON_SHEET",
        level: "warning",
        message: `The sheet is against invoice ${sheet.invoiceNo}, but the trip sheet row names no invoice.`,
      });
    }
  }

  if (customerMismatch(expected.customerName, sheet.customerName, null)) {
    issues.push({
      code: "CUSTOMER_MISMATCH",
      level: "warning",
      message: `The sheet is for ${sheet.customerName}; the trip sheet says ${expected.customerName}.`,
    });
  }

  if (source === "AI") {
    issues.push({
      code: "READ_FROM_SCAN",
      level: "warning",
      message: "Read from a scan — check the lines against the sheet.",
    });
  }

  return {
    status: issues.some((i) => i.level === "review") ? "NEEDS_REVIEW" : "READY",
    issues,
    lineType,
  };
}
