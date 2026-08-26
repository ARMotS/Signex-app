import { NextRequest, NextResponse } from "next/server";
import {
  saveInvoiceFile,
  getInvoiceUploadDestination,
  invoiceFilenameForNumber,
  sanitizeInvoiceFilename,
  looksLikePdf,
  MAX_INVOICE_UPLOAD_BYTES,
} from "@/lib/invoices";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * Upload one invoice PDF into this scope's invoice folder.
 *
 * This exists for the case where a trip sheet names an invoice whose PDF has
 * not reached the synced folder yet. The dispatcher supplies the file from the
 * import screen and it is written to the same place the parser reads from —
 * the connected OneDrive invoice folder, or the locally synced folder set in
 * Settings. See `getInvoiceUploadDestination`.
 *
 * One file per request. Uploading a batch is N requests, which keeps the
 * per-file validation and the per-file error the caller has to show honest.
 */
export const maxDuration = 60;

export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const dest = await getInvoiceUploadDestination(ctx.tenantId);

  return NextResponse.json({
    destination: dest.label,
    kind: dest.kind,
    maxBytes: MAX_INVOICE_UPLOAD_BYTES,
  });
});

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "File is empty" }, { status: 400 });
  }

  if (file.size > MAX_INVOICE_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `File too large. Maximum size is ${Math.round(
          MAX_INVOICE_UPLOAD_BYTES / (1024 * 1024)
        )}MB.`,
      },
      { status: 400 }
    );
  }

  // An invoice number, when given, names the file: the parser matches a PDF by
  // its filename, so saving "scan_0042.pdf" for invoice INV-2041 would store
  // the file and leave the stop just as unmatched as before.
  const invoiceNumber = (formData.get("invoiceNumber") as string | null)?.trim() || "";
  const targetName = invoiceNumber
    ? invoiceFilenameForNumber(invoiceNumber)
    : sanitizeInvoiceFilename(file.name);

  if (!targetName) {
    return NextResponse.json(
      { error: "Could not derive a valid filename for this invoice" },
      { status: 400 }
    );
  }

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json(
      { error: "Only PDF files can be uploaded as invoices" },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  if (!looksLikePdf(buffer)) {
    return NextResponse.json(
      { error: "That file is not a PDF (no PDF header found)" },
      { status: 400 }
    );
  }

  const overwrite = formData.get("overwrite") === "true";
  const result = await saveInvoiceFile(ctx.tenantId, targetName, buffer, { overwrite });

  if (!result.success) {
    // A name clash is a question for the dispatcher, not a failure: 409 so the
    // client can offer to replace rather than swallowing it as a generic error.
    return NextResponse.json(
      { error: result.error, conflict: result.conflict === true, filename: result.filename },
      { status: result.conflict ? 409 : 400 }
    );
  }

  return NextResponse.json({
    success: true,
    filename: result.filename,
    location: result.location,
    invoiceNumber: invoiceNumber || undefined,
  });
});
