import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import {
  resolveCollectionSource,
  saveCollectionDocument,
  sanitizeCollectionFilename,
} from "@/lib/collections";
import { looksLikePdf, MAX_INVOICE_UPLOAD_BYTES } from "@/lib/invoices";
import { loadCollectionSheet, type SheetLoadResult } from "@/lib/collection-sheet-sync";

/**
 * The office's collection sheet for one collection.
 *
 *   POST (multipart: file, overwrite?) — "Attach collection sheet": store the
 *        PDF in Collections/Pending under the collection number, then read it.
 *   PUT  { action: "reread" }  — read the recorded sheet again.
 *   PUT  { action: "approve" } — the office has checked a NEEDS_REVIEW sheet.
 *
 * ADMIN only: the sheet decides what a driver is sent to bring back. A
 * collection id from another scope is 404 through the scoped client; a closed
 * one (outcome recorded, or trip archived) is 409 — what was collected against
 * its lines is settled.
 */

async function loadOpen(ctx: Awaited<ReturnType<typeof getScope>>, id: string) {
  const collection = await ctx.db.collection.findFirst({
    where: { id },
    select: {
      id: true,
      collectionNo: true,
      status: true,
      tripSheetId: true,
      sheetStatus: true,
      sourceFilePath: true,
    },
  });
  if (!collection) {
    return { error: NextResponse.json({ error: "Collection not found" }, { status: 404 }) };
  }
  if (!collection.tripSheetId || collection.status !== "PENDING") {
    return {
      error: NextResponse.json(
        { error: "This collection is closed; its sheet can no longer be changed." },
        { status: 409 }
      ),
    };
  }
  return { collection };
}

function respond(result: SheetLoadResult) {
  switch (result.outcome) {
    case "read":
      return NextResponse.json({ success: true, ...result });
    case "not_found":
      return NextResponse.json({ error: "Collection not found" }, { status: 404 });
    case "closed":
      return NextResponse.json({ error: "This collection is closed; its sheet can no longer be changed." }, { status: 409 });
    case "missing":
      return NextResponse.json({ error: "No collection sheet is on file for this collection yet." }, { status: 404 });
    case "error":
      return NextResponse.json({ error: `The sheet could not be read: ${result.error}` }, { status: 422 });
  }
}

export const POST = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const open = await loadOpen(ctx, id);
  if (open.error) return open.error;

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose a PDF to attach" }, { status: 400 });
  }
  if (file.size > MAX_INVOICE_UPLOAD_BYTES) {
    return NextResponse.json({ error: "That file is too large" }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!looksLikePdf(buffer)) {
    return NextResponse.json({ error: "That file is not a PDF (no PDF header found)" }, { status: 400 });
  }

  // Named after the collection number, because sheets are matched to
  // collections by filename — a sheet saved under its scan's name would be
  // stored and still not found.
  const filename = sanitizeCollectionFilename(`${open.collection.collectionNo}.pdf`);
  if (!filename) {
    return NextResponse.json({ error: "Could not derive a filename for this sheet" }, { status: 400 });
  }

  const saved = await saveCollectionDocument(ctx.tenantId, filename, buffer, {
    overwrite: form.get("overwrite") === "true",
  });
  if (!saved.success) {
    // A clash is a question for the office, not a failure: replacing the sheet
    // changes what the driver is sent to collect.
    return NextResponse.json(
      { error: `${filename} is already in the collections folder`, conflict: true, filename },
      { status: 409 }
    );
  }

  await ctx.db.collection.update({
    where: { id },
    data: { sourceFilePath: filename, sourceFileId: saved.fileId ?? null },
  });

  return respond(await loadCollectionSheet(ctx.tenantId, id, { by: ctx.name }));
});

export const PUT = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const open = await loadOpen(ctx, id);
  if (open.error) return open.error;

  const body = await request.json().catch(() => ({}));

  if (body.action === "reread") {
    // A collection still marked "No sheet" may have none recorded yet: look
    // it up in the folder first, as the automatic re-check would.
    if (!open.collection.sourceFilePath) {
      await resolveCollectionSource(ctx.tenantId, open.collection);
    }
    return respond(await loadCollectionSheet(ctx.tenantId, id, { by: ctx.name }));
  }

  if (body.action === "approve") {
    if (open.collection.sheetStatus !== "NEEDS_REVIEW") {
      return NextResponse.json({ error: "Only a sheet that needs review can be approved" }, { status: 409 });
    }
    // The issues stay on the row: approving says "checked", not "nothing was wrong".
    await ctx.db.collection.updateMany({
      where: { id, sheetStatus: "NEEDS_REVIEW", status: "PENDING" },
      data: { sheetStatus: "READY", sheetReviewedBy: ctx.name, sheetReviewedAt: new Date() },
    });
    await logAudit({
      action: "STATUS_CHANGE",
      entity: "collection",
      entityId: id,
      userName: ctx.name,
      details: `Collection sheet for ${open.collection.collectionNo} approved after review`,
      tenantId: ctx.tenantId,
    });
    return NextResponse.json({ success: true, status: "READY" });
  }

  return NextResponse.json({ error: 'action must be "reread" or "approve"' }, { status: 400 });
});
