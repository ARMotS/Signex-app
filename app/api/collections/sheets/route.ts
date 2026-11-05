import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { looksLikePdf, MAX_INVOICE_UPLOAD_BYTES } from "@/lib/invoices";
import { uploadCollectionSheet } from "@/lib/collection-sheet-upload";

/** A scan goes to Claude to be read — see lib/collection-sheet.ts. */
export const maxDuration = 60;

/**
 * POST /api/collections/sheets (multipart: file, overwrite?) — the Collections
 * tab's upload, one PDF per request. Stored in Collections/Pending under the
 * number printed on it, and attached to any pending collection with that number
 * (lib/collection-sheet-upload.ts). A name already in the folder is 409 with
 * `conflict`: replacing a sheet changes what a driver is sent to collect, so it
 * is asked, and comes back with overwrite=true.
 *
 * ADMIN only: the sheet decides what a driver is sent to bring back.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose a PDF to upload" }, { status: 400 });
  }
  if (file.size > MAX_INVOICE_UPLOAD_BYTES) {
    return NextResponse.json({ error: "That file is too large" }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!looksLikePdf(buffer)) {
    return NextResponse.json({ error: "That file is not a PDF (no PDF header found)" }, { status: 400 });
  }

  const result = await uploadCollectionSheet(ctx.tenantId, {
    buffer,
    uploadName: file.name,
    overwrite: form.get("overwrite") === "true",
    by: ctx.name ?? null,
  });
  switch (result.outcome) {
    case "unreadable":
      return NextResponse.json({ error: result.error }, { status: 422 });
    case "conflict":
      return NextResponse.json(
        { error: `${result.filename} is already in the collections folder`, conflict: true, filename: result.filename },
        { status: 409 }
      );
    default:
      return NextResponse.json({ success: true, ...result }, { status: 201 });
  }
});
