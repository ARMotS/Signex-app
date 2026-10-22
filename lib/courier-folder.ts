/**
 * courier-folder.ts
 * Where courier trip sheets live in a scope's OneDrive.
 *
 * One folder does two jobs. The Trip application saves new sheets straight
 * into it (the inbox — lib/courier-inbox.ts imports them), and Signex files
 * each imported sheet's original beneath it in {YYYY}/{MM}/. So whatever sits
 * directly in the folder is waiting, and nothing is ever in two places.
 *
 * The folder is the one chosen in Settings → OneDrive; unset, it is the
 * "Courier Trip Sheets" folder beside the trip sheet folder — remembered once
 * found or created, so Settings can show it and later looks need not walk up
 * from the trip sheet folder again.
 */

import { scopedPrisma } from "./db-scoped";
import {
  ensureSubfolder,
  getParentFolderId,
  listFolderById,
  moveItemTo,
  uploadNewFileToFolder,
} from "./microsoft-graph";
import { originalFileName, originalFolder } from "./courier-sheet";

export const AUTO_FOLDER_NAME = "Courier Trip Sheets";

export interface CourierFolder {
  itemId: string;
  /** For display: "/Signex/Courier Trip Sheets". */
  path: string;
}

/**
 * This scope's courier folder, or null: no OneDrive, or no folder chosen and
 * no trip sheet folder to put one beside. `create` makes the automatic folder
 * when it does not exist yet; without it, a missing folder is just null.
 */
export async function resolveCourierFolder(
  tenantId: string,
  { create }: { create: boolean }
): Promise<CourierFolder | null> {
  const db = scopedPrisma(tenantId);
  const account = await db.cloudAccount.findFirst({
    where: { provider: "onedrive" },
    select: { id: true, folderItemId: true, folderPath: true, courierFolderItemId: true, courierFolderPath: true },
  });
  if (!account) return null;
  if (account.courierFolderItemId) {
    return { itemId: account.courierFolderItemId, path: account.courierFolderPath ?? "" };
  }
  if (!account.folderItemId) return null;

  const parent = await getParentFolderId(tenantId, account.folderItemId);
  if (!parent) return null;
  const itemId = create
    ? await ensureSubfolder(tenantId, parent, AUTO_FOLDER_NAME)
    : (await listFolderById(tenantId, parent)).find(
        (c) => c.folder && c.name.toLowerCase() === AUTO_FOLDER_NAME.toLowerCase()
      )?.id ?? null;
  if (!itemId) return null;

  const base = (account.folderPath ?? "").replace(/\/[^/]*\/?$/, "");
  const path = `${base}/${AUTO_FOLDER_NAME}`;
  // Conditional: a folder chosen in Settings meanwhile is not overwritten.
  await db.cloudAccount.updateMany({
    where: { id: account.id, courierFolderItemId: null },
    data: { courierFolderItemId: itemId, courierFolderPath: path },
  });
  return { itemId, path };
}

export interface OriginalNames {
  courierSheetNo: string;
  customerName: string;
  /** YYYY-MM-DD */
  sheetDate: string;
  sourceFileName: string;
}

/** The {YYYY}/{MM} folder beneath the courier folder, made if missing. */
async function monthFolder(tenantId: string, folder: CourierFolder, sheetDate: string) {
  const [, year, month] = originalFolder(sheetDate);
  const yearId = await ensureSubfolder(tenantId, folder.itemId, year);
  const id = await ensureSubfolder(tenantId, yearId, month);
  return { id, path: `${folder.path}/${year}/${month}` };
}

/**
 * File a sheet's original in {YYYY}/{MM} as CTS{no}_{CUSTOMER}.xlsx — never
 * replacing a file there (_2, _3 …). `upload` for a file Signex holds (a
 * manual upload); `move` for one already in OneDrive (picked up from the
 * folder), which keeps its item id. Returns where it went, for display.
 */
export async function fileCourierOriginal(
  tenantId: string,
  folder: CourierFolder,
  names: OriginalNames,
  how: { upload: { bytes: Buffer; contentType: string } } | { move: { itemId: string } }
): Promise<{ itemId: string; path: string }> {
  const target = await monthFolder(tenantId, folder, names.sheetDate);
  for (let attempt = 1; attempt <= 50; attempt++) {
    const name = originalFileName(names.courierSheetNo, names.customerName, names.sourceFileName, attempt);
    if ("upload" in how) {
      const item = await uploadNewFileToFolder(tenantId, target.id, name, how.upload.bytes, how.upload.contentType);
      if (item) return { itemId: item.id, path: `OneDrive: ${target.path}/${name}` };
    } else if ((await moveItemTo(tenantId, how.move.itemId, target.id, name)) === "moved") {
      return { itemId: how.move.itemId, path: `OneDrive: ${target.path}/${name}` };
    }
  }
  throw new Error("Could not find a free file name for the original.");
}
