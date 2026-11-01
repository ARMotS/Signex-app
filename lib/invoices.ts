/**
 * Invoice file utilities — reads PDFs from a configured local/shared folder.
 *
 * Every function takes `tenantId` first: the folder path is read from that
 * scope's AppConfig and any OneDrive access uses that scope's own connection.
 * One ADMIN can neither list, read, sign, nor delete another ADMIN's invoices.
 *
 * Priority for folder path:
 *   1. Runtime config in database (AppConfig table) — set via Settings page
 *   2. INVOICE_FOLDER_PATH environment variable
 *   3. Default ./invoices folder in project root
 *
 * Supported path formats:
 *   - A local absolute path:   C:\Invoices
 *   - A network share (UNC):   \\server\share\invoices
 *   - A mapped drive:          Z:\invoices
 */

import fs from "fs";
import path from "path";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { readConfig } from "./config";
import { wrapText } from "./collections";
import { drawnWidth } from "./pdf-measure";
import {
  getOneDriveInvoiceSource,
  listOneDriveInvoiceFiles,
  listOneDriveSignedInvoices,
  getInvoiceItemByName,
  getSignedInvoiceItemByName,
  downloadInvoiceByName,
  deleteFileById,
  uploadSignedInvoiceToOneDrive,
  uploadFileToFolder,
} from "./microsoft-graph";

/** Default fallback folder (relative to project root) */
const DEFAULT_FOLDER = path.join(process.cwd(), "invoices");

/** Get this scope's invoice folder path (config DB → env var → default) */
export async function getInvoiceFolderPath(tenantId: string): Promise<string> {
  const config = await readConfig(tenantId);
  if (config.invoiceFolderPath && config.invoiceFolderPath.trim() !== "") {
    return config.invoiceFolderPath;
  }
  return process.env.INVOICE_FOLDER_PATH || DEFAULT_FOLDER;
}

export interface InvoiceFile {
  /** Filename without extension */
  name: string;
  /** Full filename with extension */
  filename: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Last modified date as ISO string */
  lastModified: string;
  /** Invoice number extracted from filename (e.g. INV-2041 from INV-2041.pdf) */
  invoiceNumber: string;
  /** Whether a signed version exists in the signed/ subfolder */
  isSigned: boolean;
  /** Date when the invoice was signed (from signed file mtime) */
  signedAt?: string;
}

/**
 * List all PDF files in the invoice folder.
 * Uses OneDrive Graph API if an invoice folder is configured there,
 * otherwise falls back to the local filesystem.
 */
export async function listInvoiceFiles(tenantId: string): Promise<InvoiceFile[]> {
  // Try OneDrive first
  const onedrive = await getOneDriveInvoiceSource(tenantId);
  if (onedrive) {
    return listInvoiceFilesFromOneDrive(tenantId);
  }

  // Fall back to local filesystem
  return listInvoiceFilesFromLocal(tenantId);
}

async function listInvoiceFilesFromOneDrive(tenantId: string): Promise<InvoiceFile[]> {
  try {
    const [items, signedItems] = await Promise.all([
      listOneDriveInvoiceFiles(tenantId),
      listOneDriveSignedInvoices(tenantId),
    ]);

    const signedSet = new Set(signedItems.map((s) => s.name.toLowerCase()));
    const signedTimeMap = new Map(
      signedItems.map((s) => [s.name.toLowerCase(), s.lastModifiedDateTime])
    );

    return items.map((item) => {
      const name = item.name.replace(/\.pdf$/i, "");
      const isSigned = signedSet.has(item.name.toLowerCase());

      return {
        name,
        filename: item.name,
        sizeBytes: item.size,
        lastModified: item.lastModifiedDateTime,
        invoiceNumber: name.toUpperCase(),
        isSigned,
        signedAt: isSigned ? signedTimeMap.get(item.name.toLowerCase()) : undefined,
      };
    });
  } catch (err) {
    console.error("Failed to list OneDrive invoice files:", err);
    return [];
  }
}

async function listInvoiceFilesFromLocal(tenantId: string): Promise<InvoiceFile[]> {
  const folderPath = await getInvoiceFolderPath(tenantId);

  // Ensure folder exists
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    return [];
  }

  const files = fs.readdirSync(folderPath);
  const pdfFiles = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

  // Check which invoices have signed versions
  const signedFolder = path.join(folderPath, "signed");
  const signedFiles = new Set<string>();
  const signedFileTimes = new Map<string, string>();

  if (fs.existsSync(signedFolder)) {
    const signedDirFiles = fs.readdirSync(signedFolder);
    for (const sf of signedDirFiles) {
      if (sf.toLowerCase().endsWith(".pdf")) {
        signedFiles.add(sf);
        try {
          const stats = fs.statSync(path.join(signedFolder, sf));
          signedFileTimes.set(sf, stats.mtime.toISOString());
        } catch {
          // ignore stat errors
        }
      }
    }
  }

  return pdfFiles.map((filename) => {
    const filePath = path.join(folderPath, filename);
    const stats = fs.statSync(filePath);
    const name = path.parse(filename).name;
    const isSigned = signedFiles.has(filename);

    return {
      name,
      filename,
      sizeBytes: stats.size,
      lastModified: stats.mtime.toISOString(),
      invoiceNumber: name.toUpperCase(),
      isSigned,
      signedAt: isSigned ? signedFileTimes.get(filename) : undefined,
    };
  });
}

/**
 * Read a specific invoice PDF file as a Buffer.
 * Downloads from OneDrive if configured, otherwise reads from local filesystem.
 */
export async function readInvoiceFile(
  tenantId: string,
  filename: string
): Promise<Buffer | null> {
  // Try OneDrive first
  const onedrive = await getOneDriveInvoiceSource(tenantId);
  if (onedrive) {
    try {
      // One request. This used to enumerate the ENTIRE invoice folder just to
      // translate a filename into an item id, then download — so a folder of a
      // few thousand PDFs cost several paginated round trips before the
      // download even started, on the hottest path in the app.
      return await downloadInvoiceByName(tenantId, filename);
    } catch (err) {
      console.error(`Failed to read ${filename} from OneDrive:`, err);
      return null;
    }
  }

  // Fall back to local filesystem
  const folderPath = await getInvoiceFolderPath(tenantId);
  const filePath = path.join(folderPath, filename);

  // Security: prevent directory traversal
  const resolved = path.resolve(filePath);
  const resolvedFolder = path.resolve(folderPath);
  if (!resolved.startsWith(resolvedFolder)) {
    throw new Error("Invalid filename — directory traversal detected");
  }

  if (!fs.existsSync(resolved)) {
    return null;
  }

  return fs.readFileSync(resolved);
}

/**
 * Save a signed PDF back to the invoice folder (saves to signed subfolder).
 * Uploads to OneDrive if configured, otherwise saves to local filesystem.
 */
export async function saveSignedInvoice(
  tenantId: string,
  filename: string,
  pdfBuffer: Buffer,
  saveToSubfolder: boolean = true
): Promise<string> {
  return (await saveSignedInvoiceDetailed(tenantId, filename, pdfBuffer, saveToSubfolder)).path;
}

/** saveSignedInvoice, also returning the OneDrive item id (null on a local folder). */
export async function saveSignedInvoiceDetailed(
  tenantId: string,
  filename: string,
  pdfBuffer: Buffer,
  saveToSubfolder: boolean = true
): Promise<{ path: string; itemId: string | null }> {
  // Upload to OneDrive if invoice folder is configured there
  const onedrive = await getOneDriveInvoiceSource(tenantId);
  if (onedrive) {
    try {
      const itemId = await uploadSignedInvoiceToOneDrive(tenantId, filename, pdfBuffer);
      return { path: `onedrive://signed/${filename}`, itemId };
    } catch (err) {
      console.error("Failed to upload signed invoice to OneDrive:", err);
      throw err;
    }
  }

  // Fall back to local filesystem
  const folderPath = await getInvoiceFolderPath(tenantId);

  let targetPath: string;
  if (saveToSubfolder) {
    const signedFolder = path.join(folderPath, "signed");
    if (!fs.existsSync(signedFolder)) {
      fs.mkdirSync(signedFolder, { recursive: true });
    }
    targetPath = path.join(signedFolder, filename);
  } else {
    targetPath = path.join(folderPath, filename);
  }

  // Security: prevent directory traversal
  const resolved = path.resolve(targetPath);
  const resolvedFolder = path.resolve(folderPath);
  if (!resolved.startsWith(resolvedFolder)) {
    throw new Error("Invalid filename — directory traversal detected");
  }

  fs.writeFileSync(resolved, pdfBuffer);
  return { path: resolved, itemId: null };
}

/**
 * Embed a signature image (PNG) onto a PDF page at the configured position.
 * Reads position config from the database (falls back to bottom-right of last page).
 * Draws a box the size Settings shows and fits everything inside it: a label
 * ("Customer Signature"), the signature, and who signed when.
 * Returns the modified PDF as a Buffer.
 */
export async function embedSignatureOnPdf(
  tenantId: string,
  pdfBytes: Buffer,
  signatureImageBytes: Uint8Array,
  signerName?: string,
  /** Lines the customer refused. Printed on an appended page — see below. */
  rejectedLines: DeliveryException[] = []
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  // Read this scope's configured signature position
  const config = await readConfig(tenantId);
  const pos = config.signaturePosition;

  // Select the target page
  const targetPage = pos.page === "first" ? pages[0] : pages[pages.length - 1];

  // Embed the PNG signature image
  const signatureImage = await pdfDoc.embedPng(signatureImageBytes);

  const { width: pageWidth, height: pageHeight } = targetPage.getSize();
  const box = signatureBoxRect(pos, pageWidth, pageHeight);

  // A partial delivery gets one more line in the box, pointing at the
  // exceptions page — the customer's signature is for what was accepted.
  const partial = rejectedLines.length > 0;

  const [font, bold] = await Promise.all([
    pdfDoc.embedFont(StandardFonts.Helvetica),
    pdfDoc.embedFont(StandardFonts.HelveticaBold),
  ]);
  const now = new Date();
  const timestamp = now.toLocaleString("en-ZA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  // The name is typed by the customer, and the standard Helvetica font can
  // only encode Latin-1: an emoji or another script would make drawText throw
  // and fail a signature the customer has already given. Drop what it cannot
  // draw — the full name is still stored on the stop and used in the email.
  const stampName = signerName
    ?.replace(/[^\x20-\x7E -ÿ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const signedText = stampName
    ? `Signed by ${stampName} · ${timestamp}`
    : `Signed · ${timestamp}`;

  const layout = layoutSignatureBox(
    box,
    {
      label: "CUSTOMER SIGNATURE",
      notice: partial
        ? `PARTIAL DELIVERY · ${rejectedLines.length} line${rejectedLines.length !== 1 ? "s" : ""} removed — see last page`
        : null,
      signed: signedText,
    },
    { font, bold },
    { width: signatureImage.width, height: signatureImage.height }
  );

  targetPage.drawRectangle({
    ...box,
    color: rgb(0.97, 0.97, 0.95),
    borderColor: rgb(0.85, 0.83, 0.8),
    borderWidth: 0.5,
  });
  targetPage.drawImage(signatureImage, layout.image);
  targetPage.drawLine({ ...layout.rule, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  const tone = { label: rgb(0.4, 0.4, 0.4), notice: rgb(0.75, 0.15, 0.12), signed: rgb(0.45, 0.45, 0.45) };
  for (const t of layout.texts) {
    targetPage.drawText(t.text, { x: t.x, y: t.y, size: t.size, font: t.bold ? bold : font, color: tone[t.role] });
  }

  if (partial) {
    await appendDeliveryExceptionsPage(pdfDoc, rejectedLines, timestamp, stampName);
  }

  // Set PDF metadata to mark as signed
  pdfDoc.setSubject(`Signed:${now.toISOString()}`);

  const modifiedPdfBytes = await pdfDoc.save();
  return Buffer.from(modifiedPdfBytes);
}

// ─── The signature box ────────────────────────────────────────────────────

export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The signature box in points, exactly as Settings previews it: left edge at
 * x%, bottom edge at y%, width w% of the page width, height 0.45·w% of the
 * page height. Pulled back onto the page if the configured corner would push
 * it off (the preview lets it overhang).
 */
export function signatureBoxRect(
  pos: { xPercent: number; yPercent: number; widthPercent: number },
  pageWidth: number,
  pageHeight: number
): BoxRect {
  const width = Math.min(pageWidth, (pos.widthPercent / 100) * pageWidth);
  const height = Math.min(pageHeight, ((pos.widthPercent * 0.45) / 100) * pageHeight);
  const x = Math.max(0, Math.min((pos.xPercent / 100) * pageWidth, pageWidth - width));
  const y = Math.max(0, Math.min((pos.yPercent / 100) * pageHeight, pageHeight - height));
  return { x, y, width, height };
}

interface Measures {
  widthOfTextAtSize: (text: string, size: number) => number;
}

/** Word-wrap to a width, breaking a word that is wider than the line by itself. */
function wrapToWidth(text: string, font: Measures, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (drawnWidth(font, candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (drawnWidth(font, line, size) > maxWidth && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && drawnWidth(font, line.slice(0, cut), size) > maxWidth) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface SignatureBoxLayout {
  texts: { role: "label" | "notice" | "signed"; text: string; x: number; y: number; size: number; bold: boolean }[];
  image: BoxRect;
  rule: { start: { x: number; y: number }; end: { x: number; y: number } };
}

const LINE = 1.2; // line height, in font sizes
const MIN_TEXT = 4;

/**
 * Lay the box out so everything sits inside it with even padding: the label
 * (and a partial-delivery notice) at the top, the "Signed by" line at the
 * bottom, both wrapped to the box's width, and the signature scaled into what
 * is left, centred on its rule. Text shrinks before the signature is squeezed
 * below 40% of the box; in a box too small even for that, the last lines that
 * do not fit are cut with an ellipsis rather than drawn outside it.
 */
export function layoutSignatureBox(
  box: BoxRect,
  text: { label: string; notice: string | null; signed: string },
  fonts: { font: Measures; bold: Measures },
  image: { width: number; height: number }
): SignatureBoxLayout {
  const pad = Math.max(3, Math.min(8, Math.min(box.width, box.height) * 0.07));
  const gap = pad / 2;
  const innerW = box.width - pad * 2;
  const innerH = box.height - pad * 2;

  const measure = (size: number) => {
    const labelSize = size + 0.5;
    const label = wrapToWidth(text.label, fonts.bold, labelSize, innerW);
    const notice = text.notice ? wrapToWidth(text.notice, fonts.font, size, innerW) : [];
    const signed = wrapToWidth(text.signed, fonts.font, size, innerW);
    const top = label.length * labelSize * LINE + notice.length * size * LINE;
    const bottom = signed.length * size * LINE;
    return { size, labelSize, label, notice, signed, top, bottom, sig: innerH - top - bottom - gap * 2 };
  };

  let m = measure(Math.max(MIN_TEXT, Math.min(8, box.height / 9)));
  while (m.sig < innerH * 0.4 && m.size > MIN_TEXT) m = measure(Math.max(MIN_TEXT, m.size - 0.25));

  // Last resort for a tiny box: keep the signature at least a fifth of it,
  // cutting the signed line first, then the notice.
  const floor = innerH * 0.2;
  const cut = (lines: string[]) => {
    const kept = lines.slice(0, -1);
    if (kept.length) kept[kept.length - 1] = `${kept[kept.length - 1].replace(/.{1,2}$/, "")}…`;
    return kept;
  };
  while (m.sig < floor && (m.signed.length > 1 || m.notice.length > 1)) {
    if (m.signed.length > 1) m.signed = cut(m.signed);
    else m.notice = cut(m.notice);
    m.top = m.label.length * m.labelSize * LINE + m.notice.length * m.size * LINE;
    m.bottom = m.signed.length * m.size * LINE;
    m.sig = innerH - m.top - m.bottom - gap * 2;
  }

  const texts: SignatureBoxLayout["texts"] = [];
  const left = box.x + pad;
  // Baselines: the cap height sits just under the block's top, descenders
  // stay above its bottom.
  let top = box.y + box.height - pad;
  for (const line of m.label) {
    texts.push({ role: "label", text: line, x: left, y: top - m.labelSize * 0.95, size: m.labelSize, bold: true });
    top -= m.labelSize * LINE;
  }
  for (const line of m.notice) {
    texts.push({ role: "notice", text: line, x: left, y: top - m.size * 0.95, size: m.size, bold: false });
    top -= m.size * LINE;
  }
  let bottomTop = box.y + pad + m.bottom;
  for (const line of m.signed) {
    texts.push({ role: "signed", text: line, x: left, y: bottomTop - m.size * 0.95, size: m.size, bold: false });
    bottomTop -= m.size * LINE;
  }

  const ruleY = box.y + pad + m.bottom + gap;
  const areaH = Math.max(0, top - gap - (ruleY + 1));
  const scale = Math.min(innerW / image.width, areaH / image.height);
  const w = image.width * scale;
  const h = image.height * scale;

  return {
    texts,
    image: { x: box.x + (box.width - w) / 2, y: ruleY + 1, width: w, height: h },
    rule: { start: { x: left, y: ruleY }, end: { x: box.x + box.width - pad, y: ruleY } },
  };
}

/** One refused line, as printed on the exceptions page and in the email. */
export interface DeliveryException {
  description: string;
  quantity: number | null;
  reason: string;
}

/** Helvetica encodes Latin-1 only; drawText throws on anything else. */
function latin1(text: string): string {
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Append a "DELIVERY EXCEPTIONS" page listing the lines the customer refused.
 *
 * Appended rather than drawn over the invoice, for the same reason the
 * collection receipt is: the invoice layout is whatever the office printed, and
 * an overlay would eventually cover the very line items the credit note is
 * raised against. The signature box on the invoice points here.
 */
async function appendDeliveryExceptionsPage(
  pdfDoc: PDFDocument,
  lines: DeliveryException[],
  timestamp: string,
  signerName?: string
): Promise<void> {
  const width = 595.28;
  const height = 841.89;
  const margin = 56;
  const page = pdfDoc.addPage([width, height]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.06, 0.06, 0.06);
  const muted = rgb(0.45, 0.45, 0.45);
  const rule = rgb(0.8, 0.8, 0.78);

  let y = height - margin;
  page.drawText("DELIVERY EXCEPTIONS", { x: margin, y, size: 16, font: bold, color: ink });
  y -= 10;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: rule });
  y -= 22;

  const intro =
    "The lines below were removed from this delivery. They were not delivered and " +
    "are not covered by the signature on this invoice.";
  for (const l of wrapText(intro, font, 10, width - margin * 2)) {
    page.drawText(l, { x: margin, y, size: 10, font, color: muted });
    y -= 14;
  }
  y -= 10;

  const qtyX = margin;
  const itemX = margin + 50;
  const reasonX = margin + 270;
  page.drawText("QTY", { x: qtyX, y, size: 8, font: bold, color: muted });
  page.drawText("ITEM", { x: itemX, y, size: 8, font: bold, color: muted });
  page.drawText("REASON", { x: reasonX, y, size: 8, font: bold, color: muted });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 0.5, color: rule });
  y -= 14;

  for (const line of lines) {
    // Stop well clear of the footer; a run of refusals this long is not
    // realistic, and truncating beats running off the page.
    if (y < margin + 60) {
      page.drawText("…", { x: margin, y, size: 10, font, color: muted });
      break;
    }
    const item = wrapText(latin1(line.description) || "—", font, 10, reasonX - itemX - 10);
    const reason = wrapText(latin1(line.reason) || "—", font, 10, width - margin - reasonX);
    page.drawText(line.quantity != null ? String(line.quantity) : "—", { x: qtyX, y, size: 10, font, color: ink });
    const rows = Math.max(item.length, reason.length);
    for (let i = 0; i < rows; i++) {
      if (item[i]) page.drawText(item[i], { x: itemX, y: y - i * 13, size: 10, font, color: ink });
      if (reason[i]) page.drawText(reason[i], { x: reasonX, y: y - i * 13, size: 10, font, color: ink });
    }
    y -= rows * 13 + 8;
  }

  const name = signerName ? latin1(signerName) : "";
  page.drawText(
    `Acknowledged at delivery${name ? ` by ${name}` : ""} · ${timestamp}`,
    { x: margin, y: margin, size: 8, font, color: muted }
  );
}

/**
 * Check if a signed version of an invoice exists in the signed subfolder.
 */
export async function checkIfSigned(
  tenantId: string,
  filename: string
): Promise<boolean> {
  const onedrive = await getOneDriveInvoiceSource(tenantId);
  if (onedrive) {
    try {
      // Previously two full listings: one to find the `signed` subfolder, then
      // another to enumerate it. Now a single addressed lookup.
      return (await getSignedInvoiceItemByName(tenantId, filename)) !== null;
    } catch {
      return false;
    }
  }

  const folderPath = await getInvoiceFolderPath(tenantId);
  const signedPath = path.join(folderPath, "signed", filename);
  return fs.existsSync(signedPath);
}

/**
 * Delete a single invoice file.
 * Uses OneDrive Graph API if configured, otherwise local filesystem.
 * Also removes the signed copy if it exists.
 */
export async function deleteInvoiceFile(
  tenantId: string,
  filename: string
): Promise<{ success: boolean; error?: string }> {
  const onedrive = await getOneDriveInvoiceSource(tenantId);
  if (onedrive) {
    try {
      // Two addressed lookups instead of two full folder enumerations.
      const [match, signedMatch] = await Promise.all([
        getInvoiceItemByName(tenantId, filename),
        getSignedInvoiceItemByName(tenantId, filename),
      ]);
      if (match) await deleteFileById(tenantId, match.id);
      if (signedMatch) await deleteFileById(tenantId, signedMatch.id);
      return { success: true };
    } catch (err) {
      console.error(`Failed to delete invoice file ${filename} from OneDrive:`, err);
      return { success: false, error: `Failed to delete ${filename} from OneDrive` };
    }
  }

  const folderPath = await getInvoiceFolderPath(tenantId);
  const filePath = path.join(folderPath, filename);

  // Security: prevent directory traversal
  const resolved = path.resolve(filePath);
  const resolvedFolder = path.resolve(folderPath);
  if (!resolved.startsWith(resolvedFolder)) {
    return { success: false, error: "Invalid filename — directory traversal detected" };
  }

  try {
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }

    const signedPath = path.join(folderPath, "signed", filename);
    const resolvedSigned = path.resolve(signedPath);
    if (resolvedSigned.startsWith(resolvedFolder) && fs.existsSync(resolvedSigned)) {
      fs.unlinkSync(resolvedSigned);
    }

    return { success: true };
  } catch (err) {
    console.error(`Failed to delete invoice file ${filename}:`, err);
    return { success: false, error: `Failed to delete ${filename}` };
  }
}

/**
 * Delete multiple invoice files from the filesystem.
 * Returns a summary of successes and failures.
 */
export async function deleteInvoiceFiles(
  tenantId: string,
  filenames: string[]
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];

  for (const filename of filenames) {
    const result = await deleteInvoiceFile(tenantId, filename);
    if (result.success) {
      deleted++;
    } else {
      failed.push(filename);
    }
  }

  return { deleted, failed };
}

/**
 * Delete only the original invoice files (not signed copies).
 */
export async function deleteInvoiceOriginalOnly(
  tenantId: string,
  filenames: string[]
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];

  const onedrive = await getOneDriveInvoiceSource(tenantId);
  if (onedrive) {
    const items = await listOneDriveInvoiceFiles(tenantId);
    for (const filename of filenames) {
      try {
        const match = items.find((i) => i.name === filename);
        if (match) await deleteFileById(tenantId, match.id);
        deleted++;
      } catch {
        failed.push(filename);
      }
    }
    return { deleted, failed };
  }

  const folderPath = await getInvoiceFolderPath(tenantId);
  for (const filename of filenames) {
    const filePath = path.join(folderPath, filename);
    const resolved = path.resolve(filePath);
    const resolvedFolder = path.resolve(folderPath);

    if (!resolved.startsWith(resolvedFolder)) {
      failed.push(filename);
      continue;
    }

    try {
      if (fs.existsSync(resolved)) {
        fs.unlinkSync(resolved);
      }
      deleted++;
    } catch {
      failed.push(filename);
    }
  }

  return { deleted, failed };
}

export interface DuplicateGroup {
  /** The normalized invoice number shared by duplicates */
  invoiceNumber: string;
  /** Filenames that share this invoice number */
  filenames: string[];
}

/**
 * Find duplicate invoice files.
 * Detects duplicates by normalizing invoice numbers (case-insensitive)
 * and grouping files that resolve to the same invoice number or
 * appear to be copies (e.g. "INV-2041 (1).pdf").
 */
export async function findDuplicateInvoices(
  tenantId: string
): Promise<DuplicateGroup[]> {
  // Normalize: strip common copy patterns like " (1)", " - Copy", "_copy", etc.
  const normalize = (filename: string): string => {
    const name = filename.replace(/\.pdf$/i, "");
    return name
      .replace(/\s*\(\d+\)\s*$/i, "")     // " (1)", " (2)"
      .replace(/\s*-\s*copy\s*\d*$/i, "")  // " - Copy", " - Copy2"
      .replace(/_copy\d*$/i, "")           // "_copy", "_copy2"
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
  };

  // Get file list from whichever source is active
  const onedrive = await getOneDriveInvoiceSource(tenantId);
  let pdfFiles: string[];

  if (onedrive) {
    try {
      const items = await listOneDriveInvoiceFiles(tenantId);
      pdfFiles = items.map((i) => i.name);
    } catch {
      return [];
    }
  } else {
    const folderPath = await getInvoiceFolderPath(tenantId);
    if (!fs.existsSync(folderPath)) return [];
    const files = fs.readdirSync(folderPath);
    pdfFiles = files.filter((f) => f.toLowerCase().endsWith(".pdf"));
  }

  const groups = new Map<string, string[]>();
  for (const file of pdfFiles) {
    const key = normalize(file);
    const existing = groups.get(key) || [];
    existing.push(file);
    groups.set(key, existing);
  }

  // Only return groups with 2+ files
  const duplicates: DuplicateGroup[] = [];
  for (const [invoiceNumber, filenames] of groups) {
    if (filenames.length > 1) {
      duplicates.push({ invoiceNumber, filenames });
    }
  }

  return duplicates;
}

// ─── Uploading an invoice ─────────────────────────────────────────────────
//
// A trip sheet routinely arrives before the PDFs it refers to. Rather than
// leave the dispatcher to open the sync folder in Explorer and drop the file in
// by hand — on a machine that may not be the one running Signex — the missing
// invoice can be uploaded from the import screen. It is written to whatever
// this scope reads its invoices from: the connected OneDrive folder, or the
// locally synced folder configured in Settings. Uploading anywhere else would
// produce a file the parser cannot see.

/** Largest single invoice PDF accepted. Matches the trip sheet upload cap. */
export const MAX_INVOICE_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface InvoiceDestination {
  kind: "onedrive" | "local";
  /** Human-readable location, shown to the admin after a save */
  label: string;
  /** OneDrive folder item id — set when kind === "onedrive" */
  folderItemId?: string;
  /** Absolute local folder path — set when kind === "local" */
  folderPath?: string;
}

/**
 * Where a newly uploaded invoice would land for this scope.
 *
 * Deliberately mirrors the resolution order in `listInvoiceFiles` /
 * `readInvoiceFile`: OneDrive first, then the configured local folder. Writing
 * and reading must resolve identically or an upload would appear to succeed and
 * then never match.
 */
export async function getInvoiceUploadDestination(
  tenantId: string
): Promise<InvoiceDestination> {
  const onedrive = await getOneDriveInvoiceSource(tenantId);
  if (onedrive?.folderItemId) {
    return {
      kind: "onedrive",
      label: `OneDrive: ${onedrive.folderPath || "invoice folder"}`,
      folderItemId: onedrive.folderItemId,
    };
  }

  const folderPath = await getInvoiceFolderPath(tenantId);
  return { kind: "local", label: folderPath, folderPath };
}

/** Characters Windows refuses in a filename, plus the path separators. */
const ILLEGAL_FILENAME_CHARS = /[<>:"|?*\\/]/g;

/**
 * Reduce a caller-supplied name to a safe invoice filename, or null if nothing
 * usable is left.
 *
 * The name reaches us from a form field, so it gets the same treatment as the
 * filenames handed to Graph path addressing: no separators, no traversal, no
 * control characters. The `.pdf` suffix is enforced because the invoice folder
 * listing only considers PDFs — a file saved without it would be invisible to
 * the very matching this upload exists to satisfy.
 */
export function sanitizeInvoiceFilename(raw: string): string | null {
  const base = String(raw ?? "")
    .split(/[\\/]/)
    .pop() ?? "";

  const stripped = Array.from(base.trim())
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join("")
    .replace(ILLEGAL_FILENAME_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!stripped || stripped === "." || stripped === "..") return null;

  const withoutExt = stripped.replace(/\.pdf$/i, "").replace(/\.+$/, "").trim();
  if (!withoutExt) return null;

  return `${withoutExt.slice(0, 180)}.pdf`;
}

/**
 * The filename an invoice number should be saved under so the trip sheet
 * parser will match it back. Both sides are normalized before comparison, so
 * naming the file after the number as written on the sheet is enough.
 */
export function invoiceFilenameForNumber(invoiceNumber: string): string | null {
  return sanitizeInvoiceFilename(invoiceNumber);
}

/**
 * Cheap content check — the extension alone is caller-controlled.
 * Some producers emit a few bytes of preamble before the header, so the whole
 * first block is searched rather than only offset 0.
 */
export function looksLikePdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes("%PDF-");
}

export interface SaveInvoiceResult {
  success: boolean;
  /** The name the file was actually stored under */
  filename?: string;
  /** Where it landed, for display */
  location?: string;
  /** True when a file of that name already existed and overwrite was not set */
  conflict?: boolean;
  error?: string;
}

/**
 * Write an invoice PDF into this scope's invoice folder.
 *
 * Never overwrites silently: an invoice number is an identifier, and quietly
 * replacing the PDF behind one would change what a driver is about to present
 * at the door. A conflict comes back for the caller to confirm.
 */
export async function saveInvoiceFile(
  tenantId: string,
  filename: string,
  buffer: Buffer,
  options: { overwrite?: boolean } = {}
): Promise<SaveInvoiceResult> {
  const safe = sanitizeInvoiceFilename(filename);
  if (!safe) {
    return { success: false, error: "Invalid filename" };
  }

  const dest = await getInvoiceUploadDestination(tenantId);

  if (dest.kind === "onedrive") {
    try {
      if (!options.overwrite) {
        const existing = await getInvoiceItemByName(tenantId, safe);
        if (existing) {
          return {
            success: false,
            conflict: true,
            filename: safe,
            error: `"${safe}" already exists in the invoice folder`,
          };
        }
      }

      await uploadFileToFolder(
        tenantId,
        dest.folderItemId!,
        safe,
        buffer,
        "application/pdf"
      );
      return { success: true, filename: safe, location: dest.label };
    } catch (err) {
      console.error(`Failed to upload invoice ${safe} to OneDrive:`, err);
      return { success: false, error: "Failed to upload to OneDrive" };
    }
  }

  const folderPath = dest.folderPath!;
  const resolvedFolder = path.resolve(folderPath);
  const resolved = path.resolve(path.join(folderPath, safe));

  // Belt and braces: sanitizeInvoiceFilename has already removed separators.
  if (path.dirname(resolved) !== resolvedFolder) {
    return { success: false, error: "Invalid filename — directory traversal detected" };
  }

  try {
    if (!fs.existsSync(resolvedFolder)) {
      fs.mkdirSync(resolvedFolder, { recursive: true });
    }

    if (!options.overwrite && fs.existsSync(resolved)) {
      return {
        success: false,
        conflict: true,
        filename: safe,
        error: `"${safe}" already exists in the invoice folder`,
      };
    }

    fs.writeFileSync(resolved, buffer);
    return { success: true, filename: safe, location: dest.label };
  } catch (err) {
    console.error(`Failed to save invoice ${safe} to ${folderPath}:`, err);
    return { success: false, error: "Failed to write to the invoice folder" };
  }
}
