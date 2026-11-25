/**
 * Read an invoice's product lines off its PDF — for the manual trip builder,
 * where a collection is booked against the lines of an invoice already
 * delivered (session 8), and the office's review panel (session 6).
 *
 * The client's invoices come out of the same accounting system as its credit
 * notes, so they print the same table and are read by POSITION with the same
 * reader (lib/document-table.ts), no AI:
 *
 *   TAX INVOICE 634573
 *   Product no · (short name) · Bin · Description · Qty · Unit Price · Disc % · Nett
 *   220788   FUSE   4A1   30A MINI FUSE FEMALE   10   12.50   0   125.00
 *   Other: …                       Brand: …                     Uom: EACH
 *                                                 SUB TOTAL   125.00
 *
 * QUANTITIES ONLY are kept (user decision, 2026-11-25). Prices are read so the
 * lines can be checked against the SUB TOTAL — the proof no line was missed —
 * and are dropped there. What has been collected against a line is derived
 * from CollectionLine rows, never stored on the line.
 *
 * Lines are read ON DEMAND, one invoice per request, never in a sweep over
 * the folder: a scan or an unknown layout goes to Claude, which costs money
 * per invoice. A file is read once — `linesPdfFilename` records which — and a
 * MANUAL entry is never overwritten by a read.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Prisma } from "@prisma/client";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { scopedPrisma } from "./db-scoped";
import { readInvoiceNoPattern } from "./config";
import { readInvoiceFile } from "./invoices";
import { normalizeInvoiceNo, type InvoiceNoPattern } from "./invoice-number";
import {
  extractPageItems,
  parseInvoiceDate,
  readHeaderFromItems,
  segmentLines,
  valueUnder,
  type InvoiceHeader,
  type TextItem,
} from "./invoice-header";
import { readTable, readTotals, round2, type DocumentTotals } from "./document-table";

// ─── What a read gives ────────────────────────────────────────────────────

export interface InvoiceLineRead {
  lineNo: number;
  itemCode: string | null;
  shortName: string | null;
  description: string;
  qty: number;
  uom: string | null;
  /** In memory only, for the SUB TOTAL check — never stored. */
  nett: number | null;
}

export interface ParsedInvoice {
  /** The number printed on the PDF ("TAX INVOICE 634573"), as printed. */
  invoiceNo: string | null;
  header: InvoiceHeader;
  lines: InvoiceLineRead[];
  subtotal: number | null;
}

export interface LineIssue {
  code: string;
  /** "review" puts the invoice's lines in NEEDS_REVIEW; "warning" is shown only. */
  level: "review" | "warning";
  message: string;
}

export type LinesStatus = "OK" | "NEEDS_REVIEW" | "FAILED";
export type LinesSource = "TEXT" | "AI" | "MANUAL";

// ─── The text layer ───────────────────────────────────────────────────────

/**
 * "TAX INVOICE 634573", "INVOICE No. IV-634573", "Tax Invoice: 634573" — a
 * segment that IS the title, so "Invoice date" and "Invoice to:" never match.
 * A reprint's "COPY" prints close enough before it to join the same phrase.
 */
const INVOICE_TITLE = /^(?:(?:COPY|ORIGINAL|REPRINT|DUPLICATE)\s+)?(?:TAX\s+)?INVOICE\s*(?:NO\.?|NUMBER|#)?\s*:?\s*([A-Z]{0,4}-?\d[\d-]*)?$/i;
const DOC_NUMBER = /^[A-Z]{0,4}-?\d[\d-]*$/i;
const NUMBER_HEADINGS = ["invoice no", "invoice number", "invoice #"];

/** The invoice's own number: beside its title, else under an "Invoice no" heading. */
export function readPrintedInvoiceNo(items: TextItem[]): string | null {
  const lines = segmentLines(items);
  for (const row of lines) {
    for (const seg of row) {
      const m = seg.text.match(INVOICE_TITLE);
      if (!m) continue;
      if (m[1]) return m[1];
      const beside = row
        .filter((s) => s.x > seg.right && s.x - seg.right < 200 && DOC_NUMBER.test(s.text))
        .sort((a, b) => a.x - b.x)[0];
      if (beside) return beside.text;
    }
  }
  const under = valueUnder(lines, NUMBER_HEADINGS);
  return under?.match(/[A-Z]{0,4}-?\d[\d-]*/i)?.[0] ?? null;
}

/** The invoice from its pages' text items. Pure — see tests/invoice-lines.test.ts. */
export function readInvoiceFromPages(pages: TextItem[][]): ParsedInvoice {
  const first = pages[0] ?? [];
  const lines: InvoiceLineRead[] = pages
    .flatMap((page) => readTable(page))
    .map((l, i) => ({
      lineNo: i + 1,
      itemCode: l.productCode,
      shortName: l.shortName,
      description: l.description,
      qty: l.qty,
      uom: l.uom,
      nett: l.nett,
    }));
  const totals: DocumentTotals = readTotals(pages);
  return {
    invoiceNo: readPrintedInvoiceNo(first),
    header: readHeaderFromItems(first),
    lines,
    subtotal: totals.subtotal,
  };
}

// ─── Scans and unknown layouts ────────────────────────────────────────────

const INVOICE_SCHEMA = {
  type: "object",
  properties: {
    invoiceNo: { type: "string", description: 'The invoice\'s own number, as printed, or "".' },
    invoiceDate: { type: "string", description: 'The invoice date as YYYY-MM-DD (not the order date), or "".' },
    deliverToName: { type: "string", description: 'First line of the "Deliver to" block, or "".' },
    billToName: { type: "string", description: 'First line of the "Invoice to" / "Bill to" block, or "".' },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          productCode: { type: "string", description: 'The product number / item code, or "".' },
          description: { type: "string" },
          qty: { type: "number", description: "The quantity invoiced, as a positive number." },
          uom: { type: "string", description: 'Unit of measure (EACH, BOX, M…), or "".' },
          nett: { type: "number", description: "The line's total before VAT, or -1 if not printed." },
        },
        required: ["productCode", "description", "qty", "uom", "nett"],
        additionalProperties: false,
      },
    },
    subtotal: { type: "number", description: "The sub total before VAT, or -1 if not printed." },
  },
  required: ["invoiceNo", "invoiceDate", "deliverToName", "billToName", "lines", "subtotal"],
  additionalProperties: false,
} as const;

/**
 * Read an invoice the text layer could not give lines for. Structured output,
 * not a forced tool call: the current model rejects forced tool_choice, and a
 * JSON-schema response gives the same guarantee of well-formed fields.
 */
export async function readInvoiceWithClaude(pdf: Buffer): Promise<ParsedInvoice> {
  const client = new Anthropic();
  const response = await client.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 8000,
    output_config: { effort: "low", format: jsonSchemaOutputFormat(INVOICE_SCHEMA) },
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
              "This is a South African tax invoice. Read its number, its date (not the order date), " +
              "the first line of the Deliver to and Invoice to blocks, every product line of its table " +
              "on every page, and the sub total. Ignore any Other/Brand row under a line except its Uom. " +
              "Amounts as positive numbers. Dates are day-first.",
          },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal" || !response.parsed_output) {
    throw new Error(`Invoice not read (${response.stop_reason ?? "no output"})`);
  }
  const out = response.parsed_output;
  console.info(
    `[invoice-lines] Claude read an invoice: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`
  );
  const blank = (v: string) => v.trim() || null;
  const amount = (n: number) => (n >= 0 ? round2(n) : null);
  return {
    invoiceNo: blank(out.invoiceNo),
    header: {
      invoiceDate: parseInvoiceDate(out.invoiceDate),
      deliverToName: blank(out.deliverToName),
      billToName: blank(out.billToName),
    },
    // Kept as read, even a zero count: assessLines sends that to review
    // rather than letting a line silently disappear.
    lines: out.lines
      .filter((l) => l.description.trim() || l.productCode.trim())
      .map((l, i) => ({
        lineNo: i + 1,
        itemCode: blank(l.productCode),
        shortName: null,
        description: l.description.trim() || l.productCode.trim(),
        qty: Math.abs(l.qty),
        uom: blank(l.uom)?.slice(0, 20) ?? null,
        nett: amount(l.nett),
      })),
    subtotal: amount(out.subtotal),
  };
}

/** Fewer characters than this on page one: treat the PDF as a scan. */
const MIN_TEXT_LAYER_CHARS = 20;
/** Text-layer pages read; a longer invoice's later pages go unread and the totals check says so. */
const MAX_TEXT_PAGES = 10;

export async function readInvoiceDocument(
  pdf: Buffer
): Promise<{ invoice: ParsedInvoice; source: "TEXT" | "AI" }> {
  const pages = await extractPageItems(pdf, MAX_TEXT_PAGES);
  const chars = (pages[0] ?? []).reduce((n, i) => n + i.str.trim().length, 0);

  if (chars >= MIN_TEXT_LAYER_CHARS) {
    const invoice = readInvoiceFromPages(pages);
    if (invoice.lines.length > 0) return { invoice, source: "TEXT" };
    // A text layer with no table we recognise is a layout we do not know,
    // not a scan — Claude reads it rather than leaving it empty.
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("No product lines could be read, and ANTHROPIC_API_KEY is not set for the scanned-PDF fallback");
  }
  return { invoice: await readInvoiceWithClaude(pdf), source: "AI" };
}

// ─── Checks ───────────────────────────────────────────────────────────────

/**
 * What stands between a read and lines the office can book a collection
 * against. Pure. `expectedNoNormalized` is the registry row's number.
 */
export function assessLines(
  invoice: ParsedInvoice,
  expectedNoNormalized: string,
  pattern: InvoiceNoPattern = null
): { status: Exclude<LinesStatus, "FAILED">; issues: LineIssue[] } {
  const issues: LineIssue[] = [];
  const money = (n: number) => n.toFixed(2);

  if (invoice.lines.length === 0) {
    issues.push({ code: "NO_LINES", level: "review", message: "No product lines were found on the invoice." });
  }
  const badQty = invoice.lines.filter((l) => !(Number.isFinite(l.qty) && l.qty > 0));
  if (badQty.length > 0) {
    issues.push({
      code: "QTY_UNREAD",
      level: "review",
      message: `No quantity could be read on line${badQty.length > 1 ? "s" : ""} ${badQty.map((l) => l.lineNo).join(", ")}, so ${badQty.length > 1 ? "they were" : "it was"} left out.`,
    });
  }

  const printed = invoice.invoiceNo ? normalizeInvoiceNo(invoice.invoiceNo, pattern) : "";
  if (!printed) {
    issues.push({
      code: "INVOICE_NO_UNREAD",
      level: "warning",
      message: "The invoice number printed on the PDF could not be read, so it was not checked against the file's name.",
    });
  } else if (printed !== expectedNoNormalized) {
    issues.push({
      code: "INVOICE_NO_MISMATCH",
      level: "review",
      message: `The PDF prints invoice ${invoice.invoiceNo}, but it is filed as invoice ${expectedNoNormalized}.`,
    });
  }

  const allPriced = invoice.lines.length > 0 && invoice.lines.every((l) => l.nett !== null);
  if (invoice.lines.length > 0) {
    if (invoice.subtotal === null || !allPriced) {
      issues.push({
        code: "TOTALS_UNCHECKED",
        level: "review",
        message: "The sub total (or a line's amount) could not be read, so there is no check that every line was read.",
      });
    } else {
      const sum = round2(invoice.lines.reduce((s, l) => s + (l.nett ?? 0), 0));
      if (Math.abs(sum - invoice.subtotal) > 0.015) {
        issues.push({
          code: "LINES_TOTAL",
          level: "review",
          message: `The lines add up to ${money(sum)}, but the sub total is ${money(invoice.subtotal)} — a line may have been missed or misread.`,
        });
      }
    }
  }

  return { status: issues.some((i) => i.level === "review") ? "NEEDS_REVIEW" : "OK", issues };
}

// ─── Storage ──────────────────────────────────────────────────────────────

export const MAX_LINES_ATTEMPTS = 3;
/** A claim older than this is a crashed read, and can be claimed again. */
export const STALE_LINES_CLAIM_MS = 2 * 60 * 1000;

export interface InvoiceLinesView {
  id: string;
  invoiceNo: string;
  pdfFilename: string | null;
  /** null = not read yet. */
  status: LinesStatus | null;
  source: LinesSource | null;
  issues: LineIssue[];
  error: string | null;
  attempts: number;
  readAt: string | null;
  /** A read is running now (someone else's request). */
  reading: boolean;
  /** The lines were read from a different PDF than the one now on file. */
  stale: boolean;
  lines: { lineNo: number; itemCode: string | null; shortName: string | null; description: string; qty: number; uom: string | null }[];
}

const VIEW_SELECT = {
  id: true,
  invoiceNo: true,
  pdfFilename: true,
  linesStatus: true,
  linesSource: true,
  linesIssues: true,
  linesError: true,
  linesAttempts: true,
  linesReadAt: true,
  linesClaimedAt: true,
  linesPdfFilename: true,
  lines: {
    select: { lineNo: true, itemCode: true, shortName: true, description: true, qty: true, uom: true },
    orderBy: { lineNo: "asc" as const },
  },
} as const;

type ViewRow = {
  id: string;
  invoiceNo: string;
  pdfFilename: string | null;
  linesStatus: string | null;
  linesSource: string | null;
  linesIssues: unknown;
  linesError: string | null;
  linesAttempts: number;
  linesReadAt: Date | null;
  linesClaimedAt: Date | null;
  linesPdfFilename: string | null;
  lines: { lineNo: number; itemCode: string | null; shortName: string | null; description: string; qty: unknown; uom: string | null }[];
};

const claimIsLive = (claimedAt: Date | null, now = Date.now()) =>
  !!claimedAt && now - claimedAt.getTime() < STALE_LINES_CLAIM_MS;

function toView(row: ViewRow): InvoiceLinesView {
  return {
    id: row.id,
    invoiceNo: row.invoiceNo,
    pdfFilename: row.pdfFilename,
    status: (row.linesStatus as LinesStatus | null) ?? null,
    source: (row.linesSource as LinesSource | null) ?? null,
    issues: Array.isArray(row.linesIssues) ? (row.linesIssues as LineIssue[]) : [],
    error: row.linesError,
    attempts: row.linesAttempts,
    readAt: row.linesReadAt?.toISOString() ?? null,
    reading: claimIsLive(row.linesClaimedAt),
    stale:
      row.linesSource !== "MANUAL" &&
      !!row.linesPdfFilename &&
      !!row.pdfFilename &&
      row.linesPdfFilename.toLowerCase() !== row.pdfFilename.toLowerCase(),
    lines: row.lines.map((l) => ({ ...l, qty: Number(l.qty) })),
  };
}

/** The stored lines and their state, or null for an id outside the scope. */
export async function getInvoiceLines(tenantId: string, invoiceId: string): Promise<InvoiceLinesView | null> {
  const row = await scopedPrisma(tenantId).invoice.findFirst({ where: { id: invoiceId }, select: VIEW_SELECT });
  return row ? toView(row) : null;
}

/**
 * Why nothing was read: NO_PDF (a stub, or the file was deleted), MANUAL (the
 * office typed the lines — a read never replaces them), CACHED (this file was
 * read already), GAVE_UP (three failed reads of this file), BUSY (another
 * request is reading it now).
 */
export type LinesOutcome = "READ" | "FAILED" | "NO_PDF" | "MANUAL" | "CACHED" | "GAVE_UP" | "BUSY";

const sameFile = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Read an invoice's lines now, unless they are already known. One invoice per
 * call — the route is one per request, so a 20-invoice pick never runs into
 * the function time limit.
 *
 * Claimed with a lease (`linesClaimedAt`), so two people opening the same
 * invoice cause one read, not two Claude calls. The result is written only
 * while that claim still holds and the same PDF is still on file, and never
 * over a MANUAL entry made meanwhile. `force` re-reads a file already read
 * (or given up on); it still never overrides MANUAL or a live claim.
 */
export async function readInvoiceLines(
  tenantId: string,
  invoiceId: string,
  { force = false }: { force?: boolean } = {}
): Promise<{ outcome: LinesOutcome; view: InvoiceLinesView } | null> {
  const db = scopedPrisma(tenantId);
  const row = await db.invoice.findFirst({
    where: { id: invoiceId },
    select: { ...VIEW_SELECT, invoiceNoNormalized: true, headerSource: true },
  });
  if (!row) return null;
  const done = (outcome: LinesOutcome) => ({ outcome, view: toView(row) });

  if (!row.pdfFilename) return done("NO_PDF");
  if (row.linesSource === "MANUAL") return done("MANUAL");
  if (claimIsLive(row.linesClaimedAt)) return done("BUSY");

  const fileChanged = !sameFile(row.linesPdfFilename, row.pdfFilename);
  if (!force && !fileChanged) {
    if (row.linesStatus === "OK" || row.linesStatus === "NEEDS_REVIEW") return done("CACHED");
    if (row.linesAttempts >= MAX_LINES_ATTEMPTS) return done("GAVE_UP");
  }

  // The claim: conditional on the state just read, so of two racing requests
  // exactly one proceeds. A new file (or a forced re-read) starts its tries again.
  const claimedAt = new Date();
  const claim = await db.invoice.updateMany({
    where: {
      id: invoiceId,
      linesAttempts: row.linesAttempts,
      pdfFilename: row.pdfFilename,
      OR: [{ linesSource: null }, { linesSource: { not: "MANUAL" } }],
      AND: [{ OR: [{ linesClaimedAt: null }, { linesClaimedAt: { lt: new Date(claimedAt.getTime() - STALE_LINES_CLAIM_MS) } }] }],
    },
    data: {
      linesClaimedAt: claimedAt,
      linesAttempts: fileChanged || force ? 1 : { increment: 1 },
    },
  });
  if (claim.count === 0) {
    const now = await getInvoiceLines(tenantId, invoiceId);
    return now && { outcome: now.source === "MANUAL" ? "MANUAL" : "BUSY", view: now };
  }
  const attempt = fileChanged || force ? 1 : row.linesAttempts + 1;
  const ours = { id: invoiceId, linesClaimedAt: claimedAt, pdfFilename: row.pdfFilename };

  try {
    const pdf = await readInvoiceFile(tenantId, row.pdfFilename);
    if (!pdf) throw new Error(`${row.pdfFilename} is not in the invoice folder`);
    const { invoice, source } = await readInvoiceDocument(pdf);
    const { status, issues } = assessLines(invoice, row.invoiceNoNormalized, await readInvoiceNoPattern(tenantId));

    const written = await db.$transaction(async (tx) => {
      const update = await tx.invoice.updateMany({
        where: ours,
        data: {
          linesStatus: status,
          linesSource: source,
          linesIssues: issues as unknown as Prisma.InputJsonValue,
          linesError: null,
          linesReadAt: new Date(),
          linesPdfFilename: row.pdfFilename,
          linesClaimedAt: null,
        },
      });
      if (update.count === 0) return false; // claim lost, file replaced, or typed in by hand meanwhile
      await tx.invoiceLine.deleteMany({ where: { invoiceId } });
      // A line with no quantity is left out; QTY_UNREAD keeps it in front of the office.
      const kept = invoice.lines.filter((l) => Number.isFinite(l.qty) && l.qty > 0);
      if (kept.length > 0) {
        await tx.invoiceLine.createMany({
          data: kept.map((l) => ({
            invoiceId,
            lineNo: l.lineNo,
            itemCode: l.itemCode?.slice(0, 60) ?? null,
            shortName: l.shortName?.slice(0, 120) ?? null,
            description: l.description.slice(0, 500),
            qty: l.qty,
            uom: l.uom,
          })),
        });
      }
      // One download, one read: fill the header too while it is unread. Never
      // over a header already read, or corrected by hand (MANUAL).
      if (row.headerSource === null) {
        await tx.invoice.updateMany({
          where: { id: invoiceId, headerSource: null },
          data: {
            invoiceDate: invoice.header.invoiceDate,
            deliverToName: invoice.header.deliverToName,
            billToName: invoice.header.billToName,
            headerSource: source,
            headerError: null,
          },
        });
      }
      return true;
    });

    const view = await getInvoiceLines(tenantId, invoiceId);
    return view && { outcome: written ? "READ" : view.source === "MANUAL" ? "MANUAL" : "BUSY", view };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    const spent = attempt >= MAX_LINES_ATTEMPTS;
    await db.$transaction(async (tx) => {
      if (fileChanged) {
        // Lines from the PDF that used to be filed here describe another
        // document: drop them, and count this file's tries from here on.
        const update = await tx.invoice.updateMany({
          where: ours,
          data: {
            linesClaimedAt: null,
            linesError: error,
            linesStatus: spent ? "FAILED" : null,
            linesSource: null,
            linesIssues: [],
            linesReadAt: null,
            linesPdfFilename: row.pdfFilename,
          },
        });
        if (update.count > 0) await tx.invoiceLine.deleteMany({ where: { invoiceId } });
        return;
      }
      // A forced re-read of a file read before keeps the lines it had; only a
      // file never read successfully is marked FAILED, once its tries are spent.
      const neverRead = row.linesStatus === null || row.linesStatus === "FAILED";
      await tx.invoice.updateMany({
        where: ours,
        data: {
          linesClaimedAt: null,
          linesError: error,
          ...(spent && neverRead ? { linesStatus: "FAILED" } : {}),
        },
      });
    });
    const view = await getInvoiceLines(tenantId, invoiceId);
    return view && { outcome: "FAILED", view };
  }
}
