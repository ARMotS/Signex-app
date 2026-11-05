/**
 * A collection sheet uploaded on the Collections tab, with no collection chosen.
 *
 * Sheets are matched to collections by FILENAME, so the name it is kept under
 * comes from the number printed on the sheet, never from whatever the scan was
 * called (the same reasoning as an invoice upload). It goes to Pending/ and:
 *
 *   • attaches to any pending collection on a live trip with that number, and
 *     is read at once;
 *   • otherwise waits, and is found when that number arrives on a trip sheet.
 *
 * It never creates a collection: those arrive on a trip sheet with a driver and
 * a stop, and a sheet alone has neither.
 */

import { logAudit } from "./audit";
import { scopedPrisma } from "./db-scoped";
import { collectionMatchKeys, sameCollectionNumber, sanitizeCollectionFilename, saveCollectionDocument } from "./collections";
import { readCollectionSheet } from "./collection-sheet";
import { loadCollectionSheet } from "./collection-sheet-sync";

export type SheetUploadResult =
  | {
      outcome: "saved";
      filename: string;
      collectionNo: string;
      attached: { id: string; collectionNo: string; customerName: string; read: boolean }[];
      /** The number came from the file's name: nothing could be read off the sheet. */
      fromFilename: boolean;
    }
  | { outcome: "conflict"; filename: string }
  | { outcome: "unreadable"; error: string };

/**
 * The number a sheet goes by. A sheet that read but prints no number is refused:
 * an invoice or credit note in the wrong box reads too, and every PDF in the
 * folder is taken for a collection document. Only a sheet that could not be read
 * at all (a scan with no reader available) falls back to its filename.
 */
export function sheetNumberFrom(
  printed: string | null | undefined,
  couldRead: boolean,
  uploadName: string
): { number: string; fromFilename: boolean } | null {
  const number = printed?.trim();
  if (number) return { number, fromFilename: false };
  if (couldRead) return null;
  const stem = uploadName.replace(/\.pdf$/i, "").trim();
  const [, , unpadded] = collectionMatchKeys(stem);
  return unpadded && /\d/.test(stem) ? { number: stem, fromFilename: true } : null;
}

export async function uploadCollectionSheet(
  tenantId: string,
  input: { buffer: Buffer; uploadName: string; overwrite: boolean; by: string | null }
): Promise<SheetUploadResult> {
  const db = scopedPrisma(tenantId);

  let printed: string | null = null;
  let couldRead = true;
  try {
    printed = (await readCollectionSheet(input.buffer)).sheet.collectionNo;
  } catch {
    couldRead = false;
  }
  const found = sheetNumberFrom(printed, couldRead, input.uploadName);
  if (!found) {
    return {
      outcome: "unreadable",
      error: couldRead
        ? "No collection number is printed on this PDF, so it does not look like a collection sheet."
        : "This PDF could not be read and its file name holds no collection number. Rename it to the collection number and upload it again.",
    };
  }

  const pending = await db.collection.findMany({
    where: { status: "PENDING", tripSheetId: { not: null } },
    select: { id: true, collectionNo: true, customerName: true, stop: { select: { customerName: true } } },
  });
  const matches = pending.filter((c) => sameCollectionNumber(found.number, c.collectionNo));

  // As the trip sheet writes the number when one is waiting: the same name the
  // per-collection Attach would use, so the two cannot leave two copies.
  const filename = sanitizeCollectionFilename(`${matches[0]?.collectionNo ?? found.number}.pdf`);
  if (!filename) return { outcome: "unreadable", error: "Could not derive a file name for this sheet." };

  const saved = await saveCollectionDocument(tenantId, filename, input.buffer, { overwrite: input.overwrite });
  if (!saved.success) return { outcome: "conflict", filename };

  const attached: Extract<SheetUploadResult, { outcome: "saved" }>["attached"] = [];
  for (const c of matches) {
    // Conditional: a driver recording an outcome meanwhile keeps what they signed against.
    const res = await db.collection.updateMany({
      where: { id: c.id, status: "PENDING", tripSheetId: { not: null } },
      data: { sourceFilePath: filename, sourceFileId: saved.fileId ?? null },
    });
    if (res.count === 0) continue;
    const read = await loadCollectionSheet(tenantId, c.id, { by: input.by ?? undefined }).catch(() => null);
    attached.push({
      id: c.id,
      collectionNo: c.collectionNo,
      customerName: c.stop?.customerName ?? c.customerName ?? "Unknown",
      read: read?.outcome === "read",
    });
  }

  await logAudit({
    action: "UPLOAD",
    entity: "collection_document",
    userName: input.by ?? undefined,
    details: `Collection sheet ${filename} uploaded${attached.length ? ` and attached to ${attached.map((a) => a.collectionNo).join(", ")}` : ""}`,
    metadata: { filename, attached: attached.length, overwrite: input.overwrite },
    tenantId,
  });

  return { outcome: "saved", filename, collectionNo: found.number, attached, fromFilename: found.fromFilename };
}
