/**
 * The invoice folder as the office's screens read it: the Invoices tab and the
 * invoice picker (lib/invoice-picker.ts) both start here, so they list the
 * same files and agree on what each one is.
 *
 *   1. The files — from the folder index (lib/invoice-index.ts, no Graph) once
 *      its first pass is done, else by listing the folder as it always was. A
 *      folder that cannot be read throws InvoiceFolderUnreadable, never an
 *      empty list: "0 invoices" would be shown as fact.
 *   2. Their registry rows (lib/invoice-registry.ts) — the invoice date and
 *      customer. A file with no row yet gets one here ("fill": a listing never
 *      re-points an invoice at another copy of itself), and headers not read
 *      yet are read after the response.
 *
 * Both schedule the background looks (index catch-up, header reading) the tab
 * already scheduled; each is claimed per scope, so a second caller inside the
 * window costs one conditional update.
 */

import { getInvoiceFolderPath, listInvoiceFiles, InvoiceFolderUnreadable, type InvoiceFile } from "./invoices";
import { getCloudAccountStatus } from "./microsoft-graph";
import { readInvoiceIndex, type InvoiceIndexStatus } from "./invoice-index";
import { scheduleInvoiceIndexSync } from "./invoice-index-sync";
import { readInvoiceNoPattern } from "./config";
import { normalizeInvoiceNo, type InvoiceNoPattern } from "./invoice-number";
import { ensureInvoices, scheduleInvoiceHeaders } from "./invoice-registry";
import { scopedPrisma } from "./db-scoped";

export interface InvoiceFolderListing {
  files: InvoiceFile[];
  index: InvoiceIndexStatus;
  isOneDrive: boolean;
  /** What the screen names as the folder. */
  folderLabel: string;
  pattern: InvoiceNoPattern;
}

/**
 * The invoice folder's files. `startedAt` is when the request began: what is
 * left of a 60s function after the listing is the index catch-up's budget.
 */
export async function readInvoiceFolderListing(tenantId: string, startedAt = Date.now()): Promise<InvoiceFolderListing> {
  const cloudStatus = await getCloudAccountStatus(tenantId);
  const isOneDrive = !!cloudStatus?.invoiceFolderItemId;

  // The folder as the index last saw it — no Graph at all. Until the index
  // has finished its first pass, or after another folder is chosen, the
  // folder is listed here as it always was.
  const [indexed, folderPath, pattern] = await Promise.all([
    isOneDrive ? readInvoiceIndex(tenantId) : null,
    getInvoiceFolderPath(tenantId),
    readInvoiceNoPattern(tenantId),
  ]);
  const index: InvoiceIndexStatus = indexed?.status ?? { state: "off", syncedAt: null, error: null };

  let files: InvoiceFile[];
  if (indexed?.files) {
    files = indexed.files;
  } else {
    try {
      files = await listInvoiceFiles(tenantId, { strict: true });
    } catch (err) {
      if (err instanceof InvoiceFolderUnreadable && isOneDrive) scheduleInvoiceIndexSync(tenantId, 40_000);
      throw err;
    }
  }
  // Catch up with the folder after the response: usually one small request,
  // the whole first pass on a branch that has none yet. Progress is saved
  // page by page.
  if (isOneDrive) {
    scheduleInvoiceIndexSync(tenantId, Math.max(10_000, 50_000 - (Date.now() - startedAt)));
  }

  return {
    files,
    index,
    isOneDrive,
    folderLabel: isOneDrive ? `OneDrive: ${cloudStatus!.invoiceFolderPath}` : folderPath,
    pattern,
  };
}

export const INVOICE_RECORD_SELECT = {
  id: true,
  invoiceNoNormalized: true,
  pdfFilename: true,
  customerName: true,
  deliverToName: true,
  billToName: true,
  invoiceDate: true,
  headerSource: true,
  headerError: true,
  isStub: true,
} as const;

export interface InvoiceRecordRow {
  id: string;
  invoiceNoNormalized: string;
  pdfFilename: string | null;
  customerName: string | null;
  deliverToName: string | null;
  billToName: string | null;
  invoiceDate: Date | null;
  headerSource: string | null;
  headerError: string | null;
  isStub: boolean;
}

/**
 * Every listed file's registry row, by normalized number. Only files that
 * need it are registered — no row yet, or a row with no PDF recorded (a stub
 * whose PDF has turned up) — not every file on every load.
 */
export async function registerListedInvoices(
  tenantId: string,
  files: InvoiceFile[],
  pattern: InvoiceNoPattern,
  /**
   * Read headers not read yet, after the response. A caller answering every
   * keystroke (the picker's search) asks only on its opening request: a read
   * that fails spends one of an invoice's few attempts.
   */
  { readHeaders = true }: { readHeaders?: boolean } = {}
): Promise<Map<string, InvoiceRecordRow>> {
  const db = scopedPrisma(tenantId);
  const read = async () =>
    new Map<string, InvoiceRecordRow>(
      (await db.invoice.findMany({ select: INVOICE_RECORD_SELECT })).map((r) => [r.invoiceNoNormalized, r])
    );

  let byKey = await read();
  const needRow = files.filter((f) => {
    const key = normalizeInvoiceNo(f.name, pattern);
    if (!key) return false; // no number in the name: never gets a row
    const r = byKey.get(key);
    return !r || !r.pdfFilename;
  });
  if (needRow.length > 0) {
    await ensureInvoices(
      tenantId,
      needRow.map((f) => ({ invoiceNo: f.name, pdfFilename: f.filename })),
      pattern,
      { fileAuthority: "fill" }
    );
    byKey = await read();
  }
  // Headers not read yet are read after the response — no screen waits on PDFs.
  if (readHeaders) scheduleInvoiceHeaders(tenantId, { limit: 25 });
  return byKey;
}
