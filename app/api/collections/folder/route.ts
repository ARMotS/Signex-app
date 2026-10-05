import { NextResponse } from "next/server";
import { listCollectionFolder, listSignedCollectionDocuments } from "@/lib/collections";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * GET /api/collections/folder
 *
 * What is in this scope's collections folder: the pending documents a trip
 * sheet's COLLECTNO is matched against, and the signed ones filed back.
 *
 * The Collections page otherwise shows only collections that have arrived on a
 * trip sheet, so an admin had no way to see whether the folder was being read
 * at all — and an unreadable folder looked exactly like an empty one. This says
 * which folder was read, what was found, and why it could not be read.
 *
 * Opened on purpose, not polled: it lists the folder over Microsoft Graph.
 */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const [pending, signed] = await Promise.all([
    listCollectionFolder(ctx.tenantId),
    listSignedCollectionDocuments(ctx.tenantId),
  ]);

  return NextResponse.json({
    source: pending.source,
    folderPath: pending.folderPath,
    error: pending.error ?? null,
    pending: pending.documents,
    signed,
  });
});
