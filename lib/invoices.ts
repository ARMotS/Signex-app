/**
 * Invoice file utilities — reads PDFs from a configured local/shared folder.
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
import {
  getOneDriveInvoiceSource,
  listOneDriveInvoiceFiles,
  listOneDriveSignedInvoices,
  downloadFileById,
  uploadSignedInvoiceToOneDrive,
} from "./microsoft-graph";

/** Default fallback folder (relative to project root) */
const DEFAULT_FOLDER = path.join(process.cwd(), "invoices");

/** Get the configured invoice folder path (config DB → env var → default) */
export async function getInvoiceFolderPath(): Promise<string> {
  const config = await readConfig();
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
export async function listInvoiceFiles(): Promise<InvoiceFile[]> {
  // Try OneDrive first
  const onedrive = await getOneDriveInvoiceSource();
  if (onedrive) {
    return listInvoiceFilesFromOneDrive();
  }

  // Fall back to local filesystem
  return listInvoiceFilesFromLocal();
}

async function listInvoiceFilesFromOneDrive(): Promise<InvoiceFile[]> {
  try {
    const [items, signedItems] = await Promise.all([
      listOneDriveInvoiceFiles(),
      listOneDriveSignedInvoices(),
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

async function listInvoiceFilesFromLocal(): Promise<InvoiceFile[]> {
  const folderPath = await getInvoiceFolderPath();

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
export async function readInvoiceFile(filename: string): Promise<Buffer | null> {
  // Try OneDrive first
  const onedrive = await getOneDriveInvoiceSource();
  if (onedrive) {
    try {
      const items = await listOneDriveInvoiceFiles();
      const match = items.find((i) => i.name === filename);
      if (match) {
        return downloadFileById(match.id);
      }
      return null;
    } catch (err) {
      console.error(`Failed to read ${filename} from OneDrive:`, err);
      return null;
    }
  }

  // Fall back to local filesystem
  const folderPath = await getInvoiceFolderPath();
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
  filename: string,
  pdfBuffer: Buffer,
  saveToSubfolder: boolean = true
): Promise<string> {
  // Upload to OneDrive if invoice folder is configured there
  const onedrive = await getOneDriveInvoiceSource();
  if (onedrive) {
    try {
      await uploadSignedInvoiceToOneDrive(filename, pdfBuffer);
      return `onedrive://signed/${filename}`;
    } catch (err) {
      console.error("Failed to upload signed invoice to OneDrive:", err);
      throw err;
    }
  }

  // Fall back to local filesystem
  const folderPath = await getInvoiceFolderPath();

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
  return resolved;
}

/**
 * Embed a signature image (PNG) onto a PDF page at the configured position.
 * Reads position config from the database (falls back to bottom-right of last page).
 * Adds the signature image, a label ("Customer Signature"), and a timestamp.
 * Returns the modified PDF as a Buffer.
 */
export async function embedSignatureOnPdf(
  pdfBytes: Buffer,
  signatureImageBytes: Uint8Array,
  signerName?: string
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  // Read configured signature position
  const config = await readConfig();
  const pos = config.signaturePosition;

  // Select the target page
  const targetPage = pos.page === "first" ? pages[0] : pages[pages.length - 1];

  // Embed the PNG signature image
  const signatureImage = await pdfDoc.embedPng(signatureImageBytes);

  // Get page dimensions
  const { width: pageWidth, height: pageHeight } = targetPage.getSize();

  // Scale signature to fit — use configured width percentage
  const maxWidth = (pos.widthPercent / 100) * pageWidth;
  const maxHeight = maxWidth * 0.4; // aspect ratio constraint
  const imgDims = signatureImage.scale(1);
  const scale = Math.min(maxWidth / imgDims.width, maxHeight / imgDims.height, 1);
  const sigWidth = imgDims.width * scale;
  const sigHeight = imgDims.height * scale;

  // Convert percentage position to absolute PDF coordinates
  const xPos = (pos.xPercent / 100) * pageWidth;
  const yPos = (pos.yPercent / 100) * pageHeight;

  // Draw a light background box for the signature area
  targetPage.drawRectangle({
    x: xPos - 15,
    y: yPos - 15,
    width: sigWidth + 30,
    height: sigHeight + 55,
    color: rgb(0.97, 0.97, 0.95),
    borderColor: rgb(0.85, 0.83, 0.80),
    borderWidth: 0.5,
  });

  // Draw the signature image
  targetPage.drawImage(signatureImage, {
    x: xPos,
    y: yPos,
    width: sigWidth,
    height: sigHeight,
  });

  // Draw a baseline under the signature
  targetPage.drawLine({
    start: { x: xPos - 10, y: yPos - 2 },
    end: { x: xPos + sigWidth + 10, y: yPos - 2 },
    thickness: 0.5,
    color: rgb(0.7, 0.7, 0.7),
  });

  // Add label and timestamp text
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 7;
  const now = new Date();
  const timestamp = now.toLocaleString("en-ZA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  targetPage.drawText("CUSTOMER SIGNATURE", {
    x: xPos - 10,
    y: yPos + sigHeight + 20,
    size: fontSize + 1,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  const signedText = signerName
    ? `Signed by ${signerName} · ${timestamp}`
    : `Signed · ${timestamp}`;

  targetPage.drawText(signedText, {
    x: xPos - 10,
    y: yPos + sigHeight + 8,
    size: fontSize,
    font,
    color: rgb(0.6, 0.6, 0.6),
  });

  // Set PDF metadata to mark as signed
  pdfDoc.setSubject(`Signed:${now.toISOString()}`);

  const modifiedPdfBytes = await pdfDoc.save();
  return Buffer.from(modifiedPdfBytes);
}

/**
 * Check if a signed version of an invoice exists in the signed subfolder.
 */
export async function checkIfSigned(filename: string): Promise<boolean> {
  const onedrive = await getOneDriveInvoiceSource();
  if (onedrive) {
    try {
      const signedItems = await listOneDriveSignedInvoices();
      return signedItems.some((i) => i.name.toLowerCase() === filename.toLowerCase());
    } catch {
      return false;
    }
  }

  const folderPath = await getInvoiceFolderPath();
  const signedPath = path.join(folderPath, "signed", filename);
  return fs.existsSync(signedPath);
}

/**
 * Delete a single invoice file from the filesystem.
 * Also removes the signed copy if it exists.
 */
export async function deleteInvoiceFile(
  filename: string
): Promise<{ success: boolean; error?: string }> {
  const folderPath = await getInvoiceFolderPath();
  const filePath = path.join(folderPath, filename);

  // Security: prevent directory traversal
  const resolved = path.resolve(filePath);
  const resolvedFolder = path.resolve(folderPath);
  if (!resolved.startsWith(resolvedFolder)) {
    return { success: false, error: "Invalid filename — directory traversal detected" };
  }

  try {
    // Delete main file
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }

    // Delete signed copy if it exists
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
  filenames: string[]
): Promise<{ deleted: number; failed: string[] }> {
  let deleted = 0;
  const failed: string[] = [];

  for (const filename of filenames) {
    const result = await deleteInvoiceFile(filename);
    if (result.success) {
      deleted++;
    } else {
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
export async function findDuplicateInvoices(): Promise<DuplicateGroup[]> {
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
  const onedrive = await getOneDriveInvoiceSource();
  let pdfFiles: string[];

  if (onedrive) {
    try {
      const items = await listOneDriveInvoiceFiles();
      pdfFiles = items.map((i) => i.name);
    } catch {
      return [];
    }
  } else {
    const folderPath = await getInvoiceFolderPath();
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
