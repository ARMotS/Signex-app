/**
 * courier-inbox.ts
 * Courier trip sheets arriving by folder: the Trip application saves each one
 * straight into the courier folder (lib/courier-folder.ts), and Signex
 * imports it as if it had been uploaded, then files it in {YYYY}/{MM}/.
 *
 * No scheduler, as with credit notes: opening the Courier tab schedules a look
 * after the response, throttled per scope to once a minute by a claim on
 * CloudAccount.courierCheckedAt; "Check folder" forces one (5s lease). Up to
 * ten files per look, oldest first.
 *
 * Importing needs no one to review it first: it only creates the sheet —
 * nothing reaches a customer or a courier, and the checks that block the
 * handover still run. A file that cannot be imported stays where it is and
 * is listed with its reason (CourierImportFailure); it is read again when it
 * changes, after a cool-down, or on "Check folder" — not on every look.
 */

import { after } from "next/server";
import { scopedPrisma } from "./db-scoped";
import { downloadFileById, listFolderById } from "./microsoft-graph";
import { resolveCourierFolder } from "./courier-folder";
import { CourierError, importCourierSheet, storeCourierOriginal } from "./courier-import";

export const INBOX_INTERVAL_MS = 60_000;
export const INBOX_FORCED_INTERVAL_MS = 5_000;
export const INBOX_FAILURE_RETRY_MS = 15 * 60_000;
export const INBOX_PER_LOOK = 10;

/** Who an import from the folder is recorded as. */
export const FOLDER_IMPORTER = { id: "courier-folder", name: "Courier Trip Sheets folder" };

export interface InboxFile {
  id: string;
  name: string;
  lastModified: string;
}

/**
 * An Excel file the Trip application saved. Not Excel's own lock file
 * ("~$cts-200189-p5.xlsx", synced while someone has the sheet open), not a
 * hidden file, not a folder (the {YYYY} folders live here too).
 */
export function isCourierSheetFile(name: string): boolean {
  return /\.xlsx?$/i.test(name) && !name.startsWith("~$") && !name.startsWith(".");
}

export interface InboxPlan {
  /** Already imported, but its move into {YYYY}/{MM} did not finish. */
  refile: InboxFile[];
  /** To read and import, oldest first. */
  read: InboxFile[];
  /** Failures whose file is no longer in the folder. */
  gone: string[];
}

/** What one look should do. Pure, so the rules are tested on their own. */
export function planInboxLook(input: {
  files: InboxFile[];
  /** Item ids of files already imported (a sheet's sourceFileId). */
  imported: Set<string>;
  failures: Map<string, { lastModified: Date | null; updatedAt: Date }>;
  now: Date;
  force: boolean;
}): InboxPlan {
  const sheets = input.files.filter((f) => isCourierSheetFile(f.name));
  const refile = sheets.filter((f) => input.imported.has(f.id));
  const read = sheets
    .filter((f) => !input.imported.has(f.id))
    .filter((f) => {
      const failure = input.failures.get(f.id);
      if (!failure || input.force) return true;
      const changed = !failure.lastModified || new Date(f.lastModified).getTime() > failure.lastModified.getTime();
      return changed || input.now.getTime() - failure.updatedAt.getTime() >= INBOX_FAILURE_RETRY_MS;
    })
    .sort((a, b) => a.lastModified.localeCompare(b.lastModified))
    .slice(0, INBOX_PER_LOOK);
  const present = new Set(input.files.map((f) => f.id));
  const gone = [...input.failures.keys()].filter((id) => !present.has(id));
  return { refile, read, gone };
}

export type InboxResult =
  | { outcome: "not_configured" }
  | { outcome: "throttled" }
  | { outcome: "error"; error: string }
  | { outcome: "checked"; imported: number; failed: number; refiled: number; waiting: number };

/** Look in the courier folder once — see the module comment. */
export async function checkCourierInbox(
  tenantId: string,
  { force = false }: { force?: boolean } = {}
): Promise<InboxResult> {
  const db = scopedPrisma(tenantId);
  const account = await db.cloudAccount.findFirst({
    where: { provider: "onedrive" },
    select: { id: true, courierCheckedAt: true },
  });
  if (!account) return { outcome: "not_configured" };

  const minInterval = force ? INBOX_FORCED_INTERVAL_MS : INBOX_INTERVAL_MS;
  if (account.courierCheckedAt && Date.now() - account.courierCheckedAt.getTime() < minInterval) {
    return { outcome: "throttled" };
  }
  // Two looks at once: one claims, the other stands down.
  const claim = await db.cloudAccount.updateMany({
    where: { id: account.id, courierCheckedAt: account.courierCheckedAt },
    data: { courierCheckedAt: new Date() },
  });
  if (claim.count === 0) return { outcome: "throttled" };

  let files: InboxFile[];
  try {
    const folder = await resolveCourierFolder(tenantId, { create: false });
    if (!folder) return { outcome: "not_configured" };
    files = (await listFolderById(tenantId, folder.itemId))
      .filter((item) => item.file)
      .map((item) => ({ id: item.id, name: item.name, lastModified: item.lastModifiedDateTime }));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await db.cloudAccount.updateMany({ where: { id: account.id }, data: { courierError: error.slice(0, 500) } });
    return { outcome: "error", error };
  }
  await db.cloudAccount.updateMany({ where: { id: account.id, courierError: { not: null } }, data: { courierError: null } });

  const [sheets, failureRows] = await Promise.all([
    db.courierTripSheet.findMany({
      where: { sourceFileId: { in: files.map((f) => f.id) } },
      select: { id: true, sourceFileId: true },
    }),
    db.courierImportFailure.findMany({ select: { itemId: true, lastModified: true, updatedAt: true } }),
  ]);
  const sheetByItem = new Map(sheets.map((s) => [s.sourceFileId!, s.id]));
  const plan = planInboxLook({
    files,
    imported: new Set(sheetByItem.keys()),
    failures: new Map(failureRows.map((f) => [f.itemId, f])),
    now: new Date(),
    force,
  });

  let refiled = 0;
  for (const file of plan.refile) {
    if ((await storeCourierOriginal(tenantId, sheetByItem.get(file.id)!, FOLDER_IMPORTER.name)).ok) refiled++;
  }

  let imported = 0;
  let failed = 0;
  for (const file of plan.read) {
    try {
      const buffer = await downloadFileById(tenantId, file.id);
      await importCourierSheet(
        tenantId,
        { buffer, filename: file.name, templateId: null, prompts: {} },
        FOLDER_IMPORTER,
        { originalItemId: file.id }
      );
      await db.courierImportFailure.deleteMany({ where: { itemId: file.id } });
      imported++;
    } catch (err) {
      failed++;
      const code = err instanceof CourierError ? err.code : "ERROR";
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      const existing = await db.courierImportFailure.findFirst({ where: { itemId: file.id }, select: { id: true } });
      const data = { fileName: file.name, lastModified: new Date(file.lastModified), code, error };
      if (existing) {
        await db.courierImportFailure.updateMany({
          where: { id: existing.id },
          data: { ...data, attempts: { increment: 1 } },
        });
      } else {
        await db.courierImportFailure.create({ data: { itemId: file.id, ...data } });
      }
    }
  }

  if (plan.gone.length) await db.courierImportFailure.deleteMany({ where: { itemId: { in: plan.gone } } });

  const waiting = files.filter((f) => isCourierSheetFile(f.name) && !sheetByItem.has(f.id)).length - imported;
  return { outcome: "checked", imported, failed, refiled, waiting: Math.max(0, waiting) };
}

/** Look at the courier folder after the response — the Courier tab calls this on open. */
export function scheduleCourierInbox(tenantId: string): void {
  try {
    after(() =>
      checkCourierInbox(tenantId).catch((err) => console.error(`Courier folder check failed for scope ${tenantId}:`, err))
    );
  } catch {
    // No request scope.
  }
}

export interface InboxState {
  /** OneDrive is connected (the folder only exists there). */
  connected: boolean;
  /** The folder, when one is known; null until chosen or first created. */
  folderPath: string | null;
  checkedAt: string | null;
  error: string | null;
  failures: { itemId: string; fileName: string; code: string; error: string; updatedAt: string }[];
}

/** What the Courier tab shows about the folder. Database only — no OneDrive call. */
export async function courierInboxState(tenantId: string): Promise<InboxState> {
  const db = scopedPrisma(tenantId);
  const [account, failures] = await Promise.all([
    db.cloudAccount.findFirst({
      where: { provider: "onedrive" },
      select: { courierFolderPath: true, courierCheckedAt: true, courierError: true },
    }),
    db.courierImportFailure.findMany({
      orderBy: { updatedAt: "desc" },
      select: { itemId: true, fileName: true, code: true, error: true, updatedAt: true },
    }),
  ]);
  return {
    connected: !!account,
    folderPath: account?.courierFolderPath ?? null,
    checkedAt: account?.courierCheckedAt?.toISOString() ?? null,
    error: account?.courierError ?? null,
    failures: failures.map((f) => ({ ...f, updatedAt: f.updatedAt.toISOString() })),
  };
}
