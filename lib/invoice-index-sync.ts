/**
 * Keeps the invoice folder index (InvoiceFolderFile, lib/invoice-index.ts)
 * current with Microsoft Graph delta.
 *
 * The first pass over a folder reads every item once (the same pages a full
 * listing would cost, but in the background and resumable: progress is saved
 * after every page). After that Graph hands back a deltaLink, and each later
 * look asks only for what changed since — usually one small request.
 *
 * No scheduler, as with credit notes and the courier folder: opening the
 * Invoices tab schedules a look after the response (`after()`), claimed via
 * CloudAccount.invoiceCheckedAt so several open screens cost one look; Sync
 * asks for one now. Until the first pass completes the tab keeps listing the
 * folder itself, so nothing is ever shown from a half-built index.
 *
 * OneDrive personal answers delta on any folder. A drive that refuses it
 * (OneDrive for Business only supports it at the drive root) just never
 * becomes ready, and its tab keeps working the way it always did.
 */

import { after } from "next/server";
import { scopedPrisma } from "./db-scoped";
import { DeltaResyncRequired, invoiceFolderDeltaPage, type DeltaItem } from "./microsoft-graph";
import { isPdfName, nameKeyOf, parseDate } from "./invoice-index";

/** The automatic look, at most once a minute per scope. */
export const INVOICE_INDEX_RECHECK_MS = 60_000;
/** Sync pressed: a short lease, so two screens at once still cost one look. */
export const INVOICE_INDEX_SYNC_LEASE_MS = 5_000;

const SIGNED_FOLDER_NAME = "signed";

export interface PlannedRow {
  itemId: string;
  parentId: string;
  filename: string;
  nameKey: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export interface DeltaPlan {
  /** Rows to drop by item id (gone, no longer a PDF, or about to be rewritten). */
  removeItemIds: string[];
  /** Folders that went: every row inside them goes too. */
  removeParentIds: string[];
  /** Rows to (re)write, one per item, as of the last time the page mentions it. */
  upserts: PlannedRow[];
  /** The signed/ folder after this page (null when it went or was never seen). */
  signedFolderId: string | null;
  /** The invoice folder itself was deleted. */
  folderDeleted: boolean;
  /** PDFs the page did not say the folder of — the index cannot place them. */
  unplaced: number;
}

/**
 * What one page of delta means for the index. Pure.
 *
 * Every PDF under the invoice folder is kept with the folder it sits in, not
 * just the two folders the tab shows — so a folder renamed to "signed" (whose
 * children delta does not report again) is right the moment it is renamed.
 */
export function planDeltaPage(items: DeltaItem[], folderId: string, signedFolderId: string | null): DeltaPlan {
  const upserts = new Map<string, PlannedRow>();
  const removeItemIds = new Set<string>();
  const removeParentIds = new Set<string>();
  let signed = signedFolderId;
  let folderDeleted = false;
  let unplaced = 0;

  for (const item of items) {
    if (!item?.id) continue;
    if (item.id === folderId) {
      if (item.deleted) folderDeleted = true;
      continue;
    }
    if (item.deleted) {
      upserts.delete(item.id);
      removeItemIds.add(item.id);
      // A deleted item may not say whether it was a folder; a file id matches
      // no row's parent, so treating it as one costs nothing.
      removeParentIds.add(item.id);
      if (item.id === signed) signed = null;
      continue;
    }
    const parentId = item.parentReference?.id ?? null;
    if (item.folder) {
      if (parentId === folderId && item.name?.toLowerCase() === SIGNED_FOLDER_NAME) signed = item.id;
      else if (item.id === signed) signed = null; // renamed or moved away
      continue;
    }
    if (parentId && isPdfName(item.name)) {
      removeItemIds.delete(item.id);
      upserts.set(item.id, {
        itemId: item.id,
        parentId,
        filename: item.name,
        nameKey: nameKeyOf(item.name),
        sizeBytes: Math.max(0, Math.min(Number(item.size) || 0, 2_147_483_647)),
        modifiedAt: parseDate(item.lastModifiedDateTime) ?? new Date(),
      });
    } else {
      if (!parentId && isPdfName(item.name)) unplaced++;
      // Renamed to something that is not a PDF (or cannot be placed).
      upserts.delete(item.id);
      removeItemIds.add(item.id);
    }
  }

  return {
    removeItemIds: [...removeItemIds],
    removeParentIds: [...removeParentIds],
    upserts: [...upserts.values()],
    signedFolderId: signed,
    folderDeleted,
    unplaced,
  };
}

export type InvoiceIndexSyncResult =
  | { outcome: "not_configured" | "throttled" }
  | { outcome: "error"; error: string }
  | { outcome: "synced"; ready: boolean; changed: number };

/**
 * Bring the index up to date: carry on from the saved link until Graph says
 * the pass is complete, or the time budget runs out (progress is saved after
 * every page, so the next look picks up where this one stopped).
 */
export async function syncInvoiceIndex(
  tenantId: string,
  { minIntervalMs = INVOICE_INDEX_RECHECK_MS, budgetMs = 40_000 }: { minIntervalMs?: number; budgetMs?: number } = {}
): Promise<InvoiceIndexSyncResult> {
  const db = scopedPrisma(tenantId);
  const account = await db.cloudAccount.findFirst({
    where: { provider: "onedrive" },
    select: {
      id: true,
      invoiceFolderItemId: true,
      invoiceIndexFolderId: true,
      invoiceSignedFolderId: true,
      invoiceDeltaLink: true,
      invoiceIndexReadyAt: true,
      invoiceCheckedAt: true,
    },
  });
  if (!account?.invoiceFolderItemId) return { outcome: "not_configured" };
  if (account.invoiceCheckedAt && Date.now() - account.invoiceCheckedAt.getTime() < minIntervalMs) {
    return { outcome: "throttled" };
  }
  const claim = await db.cloudAccount.updateMany({
    where: { id: account.id, invoiceCheckedAt: account.invoiceCheckedAt },
    data: { invoiceCheckedAt: new Date() },
  });
  if (claim.count === 0) return { outcome: "throttled" };

  const folderId = account.invoiceFolderItemId;
  const deadline = Date.now() + budgetMs;
  let link = account.invoiceDeltaLink;
  let signedId = account.invoiceSignedFolderId;
  let ready = !!account.invoiceIndexReadyAt && account.invoiceIndexFolderId === folderId;
  let changed = 0;

  /** Start the index again from nothing — a new folder, or Graph's 410. */
  const reset = async () => {
    await db.$transaction(async (tx) => {
      await tx.invoiceFolderFile.deleteMany({ where: {} });
      await tx.cloudAccount.updateMany({
        where: { id: account.id },
        data: {
          invoiceIndexFolderId: folderId,
          invoiceSignedFolderId: null,
          invoiceDeltaLink: null,
          invoiceIndexReadyAt: null,
        },
      });
    });
    link = null;
    signedId = null;
    ready = false;
  };

  try {
    if (account.invoiceIndexFolderId !== folderId || !link) await reset();

    let resynced = false;
    for (;;) {
      let page;
      try {
        page = await invoiceFolderDeltaPage(tenantId, folderId, link);
      } catch (err) {
        if (!(err instanceof DeltaResyncRequired) || resynced) throw err;
        resynced = true;
        await reset();
        page = await invoiceFolderDeltaPage(tenantId, folderId, null);
      }

      const plan = planDeltaPage(page.items, folderId, signedId);
      if (plan.folderDeleted) {
        throw new Error("The invoice folder was deleted from OneDrive. Choose it again in Settings.");
      }
      if (plan.unplaced > 0) {
        // An index that silently dropped them would show "0 invoices" as
        // fact. Fail the look instead: an index not yet ready leaves the tab
        // listing the folder itself.
        throw new Error(`OneDrive did not say which folder ${plan.unplaced} PDF(s) are in`);
      }
      await db.$transaction(async (tx) => {
        const drop = [...plan.removeItemIds, ...plan.upserts.map((u) => u.itemId)];
        if (drop.length) await tx.invoiceFolderFile.deleteMany({ where: { itemId: { in: drop } } });
        if (plan.removeParentIds.length) {
          await tx.invoiceFolderFile.deleteMany({ where: { parentId: { in: plan.removeParentIds } } });
        }
        if (plan.upserts.length) {
          // skipDuplicates: Signex may record a file it just wrote at the same moment.
          await tx.invoiceFolderFile.createMany({ data: plan.upserts, skipDuplicates: true });
        }
      });
      changed += plan.upserts.length + plan.removeItemIds.length;
      signedId = plan.signedFolderId;

      if (page.nextLink) {
        if (page.nextLink === link) {
          // Would ask for the same page again until the budget ran out.
          throw new Error("OneDrive's reply pointed back at the page just read");
        }
        link = page.nextLink;
        await db.cloudAccount.updateMany({
          where: { id: account.id },
          data: { invoiceDeltaLink: link, invoiceSignedFolderId: signedId },
        });
        if (Date.now() < deadline) continue;
        return { outcome: "synced", ready, changed };
      }
      if (!page.deltaLink) {
        // Never call a pass complete on a reply that did not say so.
        throw new Error("OneDrive's reply had neither a next page nor a delta link");
      }
      const now = new Date();
      await db.cloudAccount.updateMany({
        where: { id: account.id },
        data: {
          invoiceDeltaLink: page.deltaLink,
          invoiceSignedFolderId: signedId,
          invoiceIndexSyncedAt: now,
          invoiceIndexError: null,
          ...(ready ? {} : { invoiceIndexReadyAt: now }),
        },
      });
      return { outcome: "synced", ready: true, changed };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`Invoice index look failed for scope ${tenantId}:`, err);
    await db.cloudAccount
      .updateMany({ where: { id: account.id }, data: { invoiceIndexError: error.slice(0, 2000) } })
      .catch(() => undefined);
    return { outcome: "error", error };
  }
}

/**
 * Look at the invoice folder after the response has gone. Without a request
 * scope (scripts, tests) it does nothing.
 */
export function scheduleInvoiceIndexSync(tenantId: string, budgetMs = 40_000): void {
  try {
    after(() =>
      syncInvoiceIndex(tenantId, { budgetMs }).catch((err) =>
        console.error(`Invoice index look failed for scope ${tenantId}:`, err)
      )
    );
  } catch {
    // No request scope.
  }
}
