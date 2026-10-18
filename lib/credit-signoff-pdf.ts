/**
 * The paperwork side of signing a credit note off: the rules a sign-off must
 * meet, the signed copy's filename, the SIGN-OFF page appended to the note,
 * and the reference page appended to each collection's signed receipt.
 *
 * Appended, never drawn over: the credit note is the accounting system's
 * document and its lines are what accounts reconciles against. Same rule as
 * the collection receipt and the delivery exceptions page.
 *
 * Pure (pdf-lib only) — tests/credit-signoff.test.ts drives it directly.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { pdfText, wrapText } from "./collections";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;

/** A drawn signature is a PNG data URL from the canvas; a few hundred KB at most. */
const MAX_SIGNATURE_BYTES = 600 * 1024;
const PNG_PREFIX = "data:image/png;base64,";

export interface SignOffInput {
  signedByName?: unknown;
  signatureImage?: unknown;
  acknowledgement?: unknown;
}

export type SignOffCheck =
  | { ok: true; signedByName: string; signatureBytes: Uint8Array; acknowledgement: string | null }
  | { ok: false; error: string };

/**
 * A sign-off needs the dispatcher's typed name and drawn signature, and —
 * whenever the note's check found anything, warning or review — a reason it
 * is fine to sign anyway. The issues are not re-argued here; they are what the
 * dispatcher was shown, and they are printed on the sign-off page.
 */
export function validateSignOff(input: SignOffInput, issueCount: number): SignOffCheck {
  const name = typeof input.signedByName === "string" ? input.signedByName.replace(/\s+/g, " ").trim() : "";
  if (name.length < 2) return { ok: false, error: "Type your name to sign." };
  if (name.length > 80) return { ok: false, error: "Keep the name under 80 characters." };

  const image = typeof input.signatureImage === "string" ? input.signatureImage : "";
  if (!image.startsWith(PNG_PREFIX)) return { ok: false, error: "Draw your signature to sign." };
  const bytes = Uint8Array.from(Buffer.from(image.slice(PNG_PREFIX.length), "base64"));
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isPng) return { ok: false, error: "The signature could not be read — draw it again." };
  if (bytes.length > MAX_SIGNATURE_BYTES) return { ok: false, error: "The signature image is too large." };

  const reason = typeof input.acknowledgement === "string" ? input.acknowledgement.replace(/\s+/g, " ").trim() : "";
  if (issueCount > 0 && reason.length < 5) {
    return { ok: false, error: "Say why it is fine to sign despite what the check found." };
  }
  if (reason.length > 600) return { ok: false, error: "Keep the reason under 600 characters." };

  return { ok: true, signedByName: name, signatureBytes: bytes, acknowledgement: issueCount > 0 ? reason : null };
}

/**
 * CN{creditNo}_INV{invoiceNo}_COL{collectionNo}.pdf — the client's naming, so
 * the signed copy says what it closes off. Several collections are joined
 * with "-" (three at most, then "+N"); a part with nothing to say is left out.
 */
export function signedCreditFilename(
  creditNo: string,
  invoiceNo: string | null,
  collectionNos: string[]
): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9-]/g, "");
  const parts = [`CN${clean(creditNo)}`];
  if (invoiceNo && clean(invoiceNo)) parts.push(`INV${clean(invoiceNo)}`);
  const cols = [...new Set(collectionNos.map(clean).filter(Boolean))];
  if (cols.length > 0) {
    parts.push(`COL${cols.slice(0, 3).join("-")}${cols.length > 3 ? `+${cols.length - 3}` : ""}`);
  }
  return `${parts.join("_")}.pdf`;
}

export interface SignOffPageData {
  creditNo: string;
  creditDate: Date | null;
  invoiceNo: string | null;
  customerName: string | null;
  accountNo: string | null;
  subtotal: number | null;
  vatAmount: number | null;
  total: number | null;
  lines: {
    lineNo: number;
    productCode: string | null;
    description: string;
    qty: number;
    allocations: { collectionNo: string; qty: number }[];
  }[];
  collections: { collectionNo: string; status: string; collectedAt: Date | null }[];
  acknowledged: { message: string }[];
  acknowledgement: string | null;
  signedByName: string;
  signedByLogin: string;
  signedAt: Date;
}

const ink = rgb(0.06, 0.06, 0.06);
const muted = rgb(0.45, 0.45, 0.45);
const rule = rgb(0.8, 0.8, 0.78);
const amber = rgb(0.65, 0.4, 0.05);

const money = (n: number | null) =>
  n === null ? "—" : `R ${n.toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d: Date | null) =>
  d ? d.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
const stamp = (d: Date) =>
  d.toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** A page cursor that starts a new page when the next block will not fit. */
class Cursor {
  page: PDFPage;
  y: number;
  constructor(private doc: PDFDocument) {
    this.page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }
  need(height: number) {
    if (this.y - height < MARGIN) {
      this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      this.y = PAGE_HEIGHT - MARGIN;
    }
  }
  text(s: string, x: number, size: number, font: PDFFont, color = ink) {
    this.page.drawText(s, { x, y: this.y, size, font, color });
  }
  line(thickness = 0.5) {
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_WIDTH - MARGIN, y: this.y }, thickness, color: rule });
  }
}

function title(c: Cursor, bold: PDFFont, text: string) {
  c.text(text, MARGIN, 16, bold);
  c.y -= 10;
  c.line(1);
  c.y -= 26;
}

function rows(c: Cursor, font: PDFFont, bold: PDFFont, entries: [string, string | null][]) {
  const labelWidth = 120;
  const valueWidth = PAGE_WIDTH - MARGIN * 2 - labelWidth;
  for (const [label, value] of entries) {
    if (!value) continue;
    const lines = wrapText(pdfText(value), font, 10, valueWidth);
    c.need(Math.max(22, lines.length * 13 + 9));
    c.text(label.toUpperCase(), MARGIN, 8, font, muted);
    lines.forEach((l, i) => c.page.drawText(l, { x: MARGIN + labelWidth, y: c.y - i * 13, size: 10, font: i === 0 ? bold : font, color: ink }));
    c.y -= Math.max(22, lines.length * 13 + 9);
  }
}

/**
 * The credit note with a SIGN-OFF page appended. `includesSource` is false
 * when the original could not be read (the sign-off page then stands alone);
 * the caller must not remove the original in that case.
 */
export async function buildSignedCreditNotePdf(
  source: Buffer | null,
  data: SignOffPageData,
  signaturePng: Uint8Array
): Promise<{ pdf: Buffer; includesSource: boolean }> {
  let doc: PDFDocument;
  let includesSource = false;
  try {
    doc = source ? await PDFDocument.load(source) : await PDFDocument.create();
    includesSource = !!source;
  } catch {
    doc = await PDFDocument.create();
  }
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const cols = { code: MARGIN, desc: MARGIN + 80, qty: PAGE_WIDTH - MARGIN - 150, against: PAGE_WIDTH - MARGIN - 110 };
  const tableHeader = (c: Cursor) => {
    for (const [label, x] of [["PRODUCT", cols.code], ["DESCRIPTION", cols.desc], ["QTY", cols.qty], ["COLLECTED ON", cols.against]] as const) {
      c.text(label, x, 7, bold, muted);
    }
    c.y -= 6;
    c.line();
    c.y -= 12;
  };

  const c = new Cursor(doc);
  title(c, bold, "CREDIT NOTE SIGN-OFF");
  rows(c, font, bold, [
    ["Credit note", data.creditNo],
    ["Credit date", day(data.creditDate)],
    ["Credits invoice", data.invoiceNo],
    ["Customer", [data.customerName, data.accountNo].filter(Boolean).join(" · ") || null],
    ["Total", `${money(data.total)} (sub total ${money(data.subtotal)}, VAT ${money(data.vatAmount)})`],
    [
      "Collections",
      data.collections.length
        ? data.collections
            .map((col) => `${col.collectionNo} (${col.status.toLowerCase()}${col.collectedAt ? `, ${day(col.collectedAt)}` : ""})`)
            .join(", ")
        : "None linked",
    ],
  ]);

  // ── Lines: what is credited, and what came back that it pays for ──
  c.y -= 4;
  c.need(40);
  tableHeader(c);
  for (const line of data.lines) {
    const desc = wrapText(pdfText(line.description), font, 9, cols.qty - cols.desc - 10);
    const against = line.allocations.length
      ? line.allocations.map((a) => `${a.qty} on ${a.collectionNo}`).join(", ")
      : "not matched";
    const before = c.page;
    c.need(desc.length * 11 + 8);
    if (c.page !== before) tableHeader(c); // the table carries on over the page
    c.text(pdfText(line.productCode ?? "—").slice(0, 14) || "—", cols.code, 9, font);
    desc.forEach((t, i) => c.page.drawText(t, { x: cols.desc, y: c.y - i * 11, size: 9, font, color: ink }));
    c.text(String(line.qty), cols.qty, 9, bold);
    c.text(pdfText(against).slice(0, 30), cols.against, 8, font, line.allocations.length ? ink : amber);
    c.y -= desc.length * 11 + 6;
  }

  // ── What the check found, accepted by the dispatcher, and why ──
  if (data.acknowledged.length > 0) {
    c.y -= 8;
    c.need(40);
    c.text("CHECKED AND ACCEPTED", MARGIN, 8, bold, amber);
    c.y -= 14;
    for (const issue of data.acknowledged) {
      const lines = wrapText(pdfText(`• ${issue.message}`), font, 9, PAGE_WIDTH - MARGIN * 2);
      c.need(lines.length * 11 + 2);
      lines.forEach((l, i) => c.page.drawText(l, { x: MARGIN, y: c.y - i * 11, size: 9, font, color: ink }));
      c.y -= lines.length * 11 + 2;
    }
    if (data.acknowledgement) {
      const lines = wrapText(pdfText(`Reason: ${data.acknowledgement}`), bold, 9, PAGE_WIDTH - MARGIN * 2);
      c.need(lines.length * 11 + 4);
      c.y -= 4;
      lines.forEach((l, i) => c.page.drawText(l, { x: MARGIN, y: c.y - i * 11, size: 9, font: bold, color: ink }));
      c.y -= lines.length * 11;
    }
  }

  // ── The signature ──
  c.y -= 16;
  c.need(150);
  c.line();
  c.y -= 18;
  c.text("Checked against the goods collected and approved for credit.", MARGIN, 9, font);
  c.y -= 20;
  c.text("SIGNED OFF BY", MARGIN, 8, font, muted);
  c.y -= 12;
  const image = await doc.embedPng(signaturePng);
  const dims = image.scale(1);
  const scale = Math.min(200 / dims.width, 70 / dims.height, 1);
  const w = dims.width * scale;
  const h = dims.height * scale;
  c.page.drawImage(image, { x: MARGIN, y: c.y - h, width: w, height: h });
  c.y -= h + 6;
  c.page.drawLine({ start: { x: MARGIN, y: c.y }, end: { x: MARGIN + 240, y: c.y }, thickness: 0.5, color: rule });
  c.y -= 13;
  c.text(pdfText(data.signedByName), MARGIN, 10, bold);
  c.y -= 13;
  c.text(pdfText(`Office login ${data.signedByLogin} · ${stamp(data.signedAt)}`), MARGIN, 8.5, font, muted);

  doc.setSubject(`CreditNote:${data.creditNo}:SIGNED`);
  return { pdf: Buffer.from(await doc.save()), includesSource };
}

export interface CreditReference {
  creditNo: string;
  creditDate: Date | null;
  invoiceNo: string | null;
  total: number | null;
  /** What this note credits out of THIS collection. */
  lines: { productCode: string | null; description: string; qty: number }[];
  signedByName: string;
  signedAt: Date;
}

/**
 * A collection's signed receipt with a CREDIT NOTE REFERENCE page appended:
 * the receipt then shows, on its own, that the goods it records were credited
 * and by which note. Throws if the receipt cannot be read — the caller leaves
 * it as it was and says so.
 */
export async function appendCreditReference(receipt: Buffer, ref: CreditReference): Promise<Buffer> {
  const doc = await PDFDocument.load(receipt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const c = new Cursor(doc);
  title(c, bold, "CREDIT NOTE REFERENCE");
  rows(c, font, bold, [
    ["Credit note", ref.creditNo],
    ["Credit date", day(ref.creditDate)],
    ["Credits invoice", ref.invoiceNo],
    ["Credit total", money(ref.total)],
    ["Signed off", `${ref.signedByName} · ${stamp(ref.signedAt)}`],
  ]);
  c.y -= 4;
  c.need(30);
  c.text("CREDITED FROM THIS COLLECTION", MARGIN, 8, bold, muted);
  c.y -= 14;
  if (ref.lines.length === 0) {
    c.text("Nothing on this note was matched to this collection's lines.", MARGIN, 9, font, muted);
  }
  for (const line of ref.lines) {
    const text = wrapText(pdfText(`${line.qty} × ${line.productCode ?? ""} ${line.description}`.replace(/\s+/g, " ")), font, 9, PAGE_WIDTH - MARGIN * 2);
    c.need(text.length * 11 + 2);
    text.forEach((l, i) => c.page.drawText(l, { x: MARGIN, y: c.y - i * 11, size: 9, font, color: ink }));
    c.y -= text.length * 11 + 2;
  }
  return Buffer.from(await doc.save());
}
