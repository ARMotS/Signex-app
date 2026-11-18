/**
 * The invoice folder index — what the Invoices tab reads instead of listing
 * the invoice folder over Microsoft Graph on every load.
 *
 * `InvoiceFolderFile` holds one row per PDF under the invoice folder. Whether
 * a row is an original or a signed copy is decided here, at read time, from
 * the folder it sits in: the invoice folder itself, or its "signed" subfolder.
 *
 * Two things keep it current:
 *   • Graph delta, in the background (lib/invoice-index-sync.ts) — picks up
 *     whatever arrives from outside: the accounting software's PDFs, files
 *     moved or deleted by hand in OneDrive.
 *   • Signex's own writes, recorded the moment they succeed (below) — so a
 *     signature shows as signed without waiting for the next look.
 *
 * It is a cache, never an authority. Matching, deploys, signing and viewing a
 * PDF all still go to the folder. Everything here is best-effort where it
 * touches a write path: a failure to record must never fail a signature or an
 * upload — the next delta look puts the row right.
 *
 * Only database access here (no Graph), so lib/invoices.ts can import it.
 */

import { scopedPrisma } from "./db-scoped";

/** OneDrive names are case-insensitive within a folder. */
export function nameKeyOf(filename: string): string {
  return filename.toLowerCase();
}

export function isPdfName(name: string | null | undefined): name is string {
  return !!name && name.toLowerCase().endsWith(".pdf");
}

export interface IndexRow {
  parentId: string;
  filename: string;
  nameKey: string;
  sizeBytes: number;
  modifiedAt: Date;
}

/**
 * The same shape lib/invoices.ts's InvoiceFile has (kept structural, not
 * imported, so this module stays free of Graph).
 */
export interface IndexedInvoiceFile {
  name: string;
  filename: string;
  sizeBytes: number;
  lastModified: string;
  invoiceNumber: string;
  isSigned: boolean;
  signedAt?: string;
}

/**
 * Index rows → the Invoices tab's file list, exactly as listing the folder
 * would give it: one entry per original PDF, signed when signed/ holds a PDF
 * of the same name (any case). Signed copies with no original are not listed,
 * as before. Ordered by name.
 */
export function invoiceFilesFromIndex(
  rows: IndexRow[],
  folderId: string,
  signedFolderId: string | null
): IndexedInvoiceFile[] {
  const signed = new Map<string, Date>();
  if (signedFolderId) {
    for (const r of rows) {
      if (r.parentId === signedFolderId && isPdfName(r.filename)) signed.set(r.nameKey, r.modifiedAt);
    }
  }
  return rows
    .filter((r) => r.parentId === folderId && isPdfName(r.filename))
    .sort((a, b) => (a.nameKey < b.nameKey ? -1 : a.nameKey > b.nameKey ? 1 : 0))
    .map((r) => {
      const name = r.filename.replace(/\.pdf$/i, "");
      const signedAt = signed.get(r.nameKey);
      return {
        name,
        filename: r.filename,
        sizeBytes: r.sizeBytes,
        lastModified: r.modifiedAt.toISOString(),
        invoiceNumber: name.toUpperCase(),
        isSigned: signedAt !== undefined,
        signedAt: signedAt?.toISOString(),
      };
    });
}

export type InvoiceIndexState = "ready" | "building" | "off";

export interface InvoiceIndexStatus {
  /**
   * ready — the tab is read from the index. building — the first pass has not
   * finished (or the folder changed), so the tab lists the folder itself. off —
   * no OneDrive invoice folder; a local folder is read directly.
   */
  state: InvoiceIndexState;
  /** Last look at the folder that worked. */
  syncedAt: string | null;
  /** Why the last look failed, if it did. */
  error: string | null;
}

/**
 * The invoice list from the index, or null when the index cannot answer for
 * the folder configured now (not built yet, or built for another folder).
 */
export async function readInvoiceIndex(
  tenantId: string
): Promise<{ files: IndexedInvoiceFile[]; status: InvoiceIndexStatus } | { files: null; status: InvoiceIndexStatus }> {
  const db = scopedPrisma(tenantId);
  const account = await db.cloudAccount.findFirst({
    where: { provider: "onedrive" },
    select: {
      invoiceFolderItemId: true,
      invoiceIndexFolderId: true,
      invoiceSignedFolderId: true,
      invoiceIndexReadyAt: true,
      invoiceIndexSyncedAt: true,
      invoiceIndexError: true,
    },
  });
  if (!account?.invoiceFolderItemId) {
    return { files: null, status: { state: "off", syncedAt: null, error: null } };
  }
  const ready = !!account.invoiceIndexReadyAt && account.invoiceIndexFolderId === account.invoiceFolderItemId;
  const status: InvoiceIndexStatus = {
    state: ready ? "ready" : "building",
    syncedAt: ready ? account.invoiceIndexSyncedAt?.toISOString() ?? null : null,
    error: account.invoiceIndexError,
  };
  if (!ready) return { files: null, status };

  const folders = [account.invoiceFolderItemId, account.invoiceSignedFolderId].filter((id): id is string => !!id);
  const rows = await db.invoiceFolderFile.findMany({
    where: { parentId: { in: folders } },
    select: { parentId: true, filename: true, nameKey: true, sizeBytes: true, modifiedAt: true },
  });
  return { files: invoiceFilesFromIndex(rows, account.invoiceFolderItemId, account.invoiceSignedFolderId), status };
}

/** A file as Graph describes it after an upload. */
export interface WrittenItem {
  id?: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  parentReference?: { id?: string };
}

/**
 * Record a PDF Signex itself just wrote into the invoice folder or signed/.
 * Best-effort: never throws. `signed` also teaches the index which folder is
 * signed/ when Signex has just created it, before delta reports it.
 */
export async function recordInvoiceFolderWrite(
  tenantId: string,
  item: WrittenItem | null | undefined,
  { signed = false }: { signed?: boolean } = {}
): Promise<void> {
  const itemId = item?.id;
  const parentId = item?.parentReference?.id;
  const filename = item?.name;
  if (!itemId || !parentId || !isPdfName(filename)) return;
  try {
    const db = scopedPrisma(tenantId);
    const data = {
      parentId,
      filename,
      nameKey: nameKeyOf(filename),
      sizeBytes: Math.max(0, Math.min(item.size ?? 0, 2_147_483_647)),
      modifiedAt: parseDate(item.lastModifiedDateTime) ?? new Date(),
    };
    const updated = await db.invoiceFolderFile.updateMany({ where: { itemId }, data });
    if (updated.count === 0) {
      // A delta look may insert the same item at the same moment; theirs is
      // as good as ours.
      await db.invoiceFolderFile.createMany({ data: [{ itemId, ...data }], skipDuplicates: true });
    }
    if (signed) {
      await db.cloudAccount.updateMany({
        where: { provider: "onedrive", invoiceSignedFolderId: null },
        data: { invoiceSignedFolderId: parentId },
      });
    }
  } catch (err) {
    console.error(`Invoice index: could not record ${filename} for scope ${tenantId}:`, err);
  }
}

/** Forget files Signex itself just deleted, by OneDrive item id. Best-effort. */
export async function forgetInvoiceFolderItems(tenantId: string, itemIds: string[]): Promise<void> {
  const ids = itemIds.filter(Boolean);
  if (ids.length === 0) return;
  try {
    await scopedPrisma(tenantId).invoiceFolderFile.deleteMany({ where: { itemId: { in: ids } } });
  } catch (err) {
    console.error(`Invoice index: could not forget ${ids.length} deleted file(s) for scope ${tenantId}:`, err);
  }
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
