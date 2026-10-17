/**
 * Read an invoice's own date and customer off its PDF — the header only,
 * never the line items.
 *
 * Digitally generated invoices carry a text layer, so the cheap path reads it
 * by POSITION, not by regex over a flattened string. The client's layout is a
 * row of labels with a row of values under it:
 *
 *     Account no   Order no   Order date    Branch   Invoice date
 *     A136         waseem     14/10/2026    J1       14/10/2026
 *
 * Flattened, the date is nowhere near its label and the order date looks the
 * same, so "Invoice Date[:\s]*(date)" finds nothing. Here the value is the date
 * directly under (or beside) the "Invoice date" label.
 *
 * Only a PDF with no usable text layer — a scan — goes to Claude.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";

export interface InvoiceHeader {
  /** UTC midnight of the invoice's calendar date. */
  invoiceDate: Date | null;
  /** First line of "Deliver to" — the real customer, even on a cash sale. */
  deliverToName: string | null;
  /** First line of "Invoice to" / "Bill to" — on a cash sale, the cash account. */
  billToName: string | null;
}

export interface TextItem {
  x: number;
  /** Top of the item, measured DOWN from the top of the page (pdf.js-extract). */
  y: number;
  str: string;
  width: number;
  height: number;
}

// ─── Dates ────────────────────────────────────────────────────────────────

const DMY = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})\b/;
const YMD = /\b(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})\b/;

/**
 * A date in a header cell. Day-first for the slashed form — invoices here are
 * South African, and a sheet that wrote 10/14/2026 would fail validation
 * rather than silently turn into the 10th of a fourteenth month.
 */
export function parseInvoiceDate(text: string): Date | null {
  const ymd = text.match(YMD);
  const dmy = ymd ? null : text.match(DMY);
  const [year, month, day] = ymd
    ? [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])]
    : dmy
    ? [Number(dmy[3]), Number(dmy[2]), Number(dmy[1])]
    : [NaN, NaN, NaN];

  if (!(year >= 2000 && year <= 2100)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31/02 and month 13 rather than letting Date roll them over.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

// ─── Layout ───────────────────────────────────────────────────────────────

/** A run of words on one line, separated from its neighbours by a column gap. */
interface Segment {
  text: string;
  x: number;
  right: number;
  y: number;
  height: number;
}

/**
 * Stitch pdf.js items back into phrases. pdf.js emits "Invoice", " ", "date"
 * as three items; a gap wider than about a character and a half is a column
 * boundary, anything narrower is a space inside a phrase.
 */
export function segmentLines(items: TextItem[]): Segment[][] {
  const words = items
    .filter((i) => i.str.trim() !== "")
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const lines: TextItem[][] = [];
  for (const word of words) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0].y - word.y) <= Math.max(2, word.height * 0.3)) line.push(word);
    else lines.push([word]);
  }

  return lines.map((line) => {
    const segments: Segment[] = [];
    for (const word of line.sort((a, b) => a.x - b.x)) {
      const last = segments[segments.length - 1];
      const gap = last ? word.x - last.right : Infinity;
      if (last && gap <= Math.max(3, word.height * 1.2)) {
        last.text += (gap > word.height * 0.15 ? " " : "") + word.str.trim();
        last.right = word.x + word.width;
      } else {
        segments.push({
          text: word.str.trim(),
          x: word.x,
          right: word.x + word.width,
          y: word.y,
          height: word.height,
        });
      }
    }
    return segments;
  });
}

const INVOICE_DATE_LABELS = ["invoice date", "inv date", "date of invoice", "tax invoice date"];
const DELIVER_TO_LABELS = ["deliver to", "delivered to", "delivery address", "ship to"];
const BILL_TO_LABELS = ["invoice to", "bill to", "billed to", "sold to"];
const ALL_LABELS = [...INVOICE_DATE_LABELS, ...DELIVER_TO_LABELS, ...BILL_TO_LABELS];

/**
 * What follows the label when a segment STARTS with one of `labels` — "" for
 * a bare label — else null. A label and its value written close together
 * ("Invoice Date: 14/10/2026") arrive as one segment.
 */
function afterLabel(text: string, labels: string[]): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  const lower = t.toLowerCase();
  for (const l of labels) {
    if (lower === l || (lower.startsWith(l) && /^[\s:.]/.test(lower.slice(l.length)))) {
      return t.slice(l.length).replace(/^[\s:.]+/, "");
    }
  }
  return null;
}

const isLabel = (s: Segment) => afterLabel(s.text, ALL_LABELS) !== null;

const centre = (s: Segment) => (s.x + s.right) / 2;

function findInvoiceDate(lines: Segment[][]): Date | null {
  for (let li = 0; li < lines.length; li++) {
    for (const seg of lines[li]) {
      const rest = afterLabel(seg.text, INVOICE_DATE_LABELS);
      if (rest === null) continue;

      // "Invoice date: 14/10/2026" in one segment, or the value beside it.
      const inline = parseInvoiceDate(rest);
      if (inline) return inline;
      const beside = lines[li]
        .filter((s) => s.x > seg.right && s.x - seg.right < 160)
        .map((s) => parseInvoiceDate(s.text))
        .find(Boolean);
      if (beside) return beside;

      // The value row under the label row: the date whose column lines up.
      const below = lines
        .slice(li + 1)
        .filter((line) => line[0].y - seg.y <= seg.height * 5)
        .flat()
        .map((s) => ({ s, date: parseInvoiceDate(s.text) }))
        .filter((c): c is { s: Segment; date: Date } => c.date !== null)
        .map((c) => ({ ...c, offset: Math.abs(centre(c.s) - centre(seg)) }))
        .filter((c) => c.offset < 70)
        .sort((a, b) => a.offset - b.offset);
      if (below[0]) return below[0].date;
    }
  }
  return null;
}

/**
 * The first line written under a party label ("Deliver to:"), within that
 * label's column — bounded on the right by the next label on its row, so the
 * side-by-side "Invoice to" / "Deliver to" boxes do not read each other.
 */
function findParty(lines: Segment[][], labels: string[]): string | null {
  for (let li = 0; li < lines.length; li++) {
    const row = lines[li];
    for (const seg of row) {
      const rest = afterLabel(seg.text, labels);
      if (rest === null) continue;
      if (rest) return rest; // "Deliver to: ACME MOTORS" on one line

      const nextLabel = row.filter((s) => s.x > seg.right && isLabel(s)).sort((a, b) => a.x - b.x)[0];
      const left = seg.x - 20;
      const right = nextLabel ? nextLabel.x - 5 : Infinity;

      for (const line of lines.slice(li + 1)) {
        if (line[0].y - seg.y > seg.height * 8) break;
        const inColumn = line.filter((s) => s.x >= left && s.x < right && !isLabel(s));
        const text = inColumn.map((s) => s.text).join(" ").trim();
        if (text) return text;
      }
    }
  }
  return null;
}

/** The header, read from the first page's text items. Pure — see the tests. */
export function readHeaderFromItems(items: TextItem[]): InvoiceHeader {
  const lines = segmentLines(items);
  return {
    invoiceDate: findInvoiceDate(lines),
    deliverToName: findParty(lines, DELIVER_TO_LABELS),
    billToName: findParty(lines, BILL_TO_LABELS),
  };
}

/** First-page text items, or [] for a PDF with no text layer. */
export async function extractFirstPageItems(pdf: Buffer): Promise<TextItem[]> {
  // Dynamic import, as lib/contact-parser.ts: the package is ESM-first.
  const { PDFExtract } = await import("pdf.js-extract");
  const data = await new PDFExtract().extractBuffer(pdf, { firstPage: 1, lastPage: 1 });
  return (data.pages[0]?.content ?? []).map(({ x, y, str, width, height }) => ({ x, y, str, width, height }));
}

// ─── Scanned PDFs ─────────────────────────────────────────────────────────

const HEADER_SCHEMA = {
  type: "object",
  properties: {
    invoiceDate: {
      type: "string",
      description: "The invoice date as YYYY-MM-DD, or an empty string if it is not printed.",
    },
    deliverToName: {
      type: "string",
      description: 'First line of the "Deliver to" block (the customer name), or "".',
    },
    billToName: {
      type: "string",
      description: 'First line of the "Invoice to" / "Bill to" block, or "".',
    },
  },
  required: ["invoiceDate", "deliverToName", "billToName"],
  additionalProperties: false,
} as const;

/**
 * Read the header of a PDF that has no text layer. Headers only — the prompt
 * asks for nothing else, so no prices or lines leave this function.
 *
 * Structured outputs rather than a forced tool call: the current model
 * rejects a forced tool_choice, and a JSON-schema response gives the same
 * guarantee of well-formed fields.
 */
export async function readHeaderWithClaude(pdf: Buffer): Promise<InvoiceHeader> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 4000,
    output_config: { effort: "low", format: jsonSchemaOutputFormat(HEADER_SCHEMA) },
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
              "This is a South African tax invoice. Read only its header: the invoice date " +
              "(not the order date), and the first line of the Deliver to and Invoice to blocks. " +
              "Dates on the document are day-first.",
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Header not read (${response.stop_reason ?? "no output"})`);
  }
  const out = response.parsed_output;
  console.info(
    `[invoice-header] Claude read a scanned invoice: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`
  );
  return {
    invoiceDate: parseInvoiceDate(out.invoiceDate),
    deliverToName: out.deliverToName.trim() || null,
    billToName: out.billToName.trim() || null,
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────

/** Fewer characters than this on page one: treat the PDF as a scan. */
const MIN_TEXT_LAYER_CHARS = 20;

export async function readInvoiceHeader(
  pdf: Buffer
): Promise<{ header: InvoiceHeader; source: "TEXT" | "AI" }> {
  const items = await extractFirstPageItems(pdf);
  const chars = items.reduce((n, i) => n + i.str.trim().length, 0);

  if (chars >= MIN_TEXT_LAYER_CHARS) {
    const header = readHeaderFromItems(items);
    if (header.invoiceDate) return { header, source: "TEXT" };
    // A text layer with no recognisable date label is a layout we do not
    // know, not a scan — Claude reads it rather than leaving it blank.
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("No readable invoice date, and ANTHROPIC_API_KEY is not set for the scanned-PDF fallback");
  }
  return { header: await readHeaderWithClaude(pdf), source: "AI" };
}
