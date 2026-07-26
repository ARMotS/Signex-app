import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { readInvoiceFile, saveSignedInvoice, embedSignatureOnPdf, getInvoiceFolderPath } from "@/lib/invoices";
import { getOneDriveInvoiceSource, listOneDriveSignedInvoices, downloadFileById } from "@/lib/microsoft-graph";
import { updateStopStatus } from "@/lib/trip-data";
import { getScope } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  // Every read resolves against the caller's own invoice folder / OneDrive
  // connection, so the same filename in two scopes returns two different files.
  const ctx = await getScope();
  const { id } = await params;
  const decodedFilename = decodeURIComponent(id);
  const { searchParams } = new URL(request.url);
  const wantSigned = searchParams.get("signed") === "true";

  if (wantSigned) {
    // Try OneDrive first
    const onedrive = await getOneDriveInvoiceSource(ctx.tenantId);
    if (onedrive) {
      try {
        const signedItems = await listOneDriveSignedInvoices(ctx.tenantId);
        const match = signedItems.find((i) => i.name === decodedFilename);
        if (match) {
          const buffer = await downloadFileById(ctx.tenantId, match.id);
          return new NextResponse(new Uint8Array(buffer), {
            headers: {
              "Content-Type": "application/pdf",
              "Content-Disposition": `inline; filename="signed-${decodedFilename}"`,
              "Cache-Control": "no-cache",
            },
          });
        }
        return NextResponse.json(
          { error: `Signed invoice "${decodedFilename}" not found` },
          { status: 404 }
        );
      } catch (err) {
        console.error("Failed to read signed invoice from OneDrive:", err);
        return NextResponse.json(
          { error: `Failed to read signed invoice from OneDrive` },
          { status: 500 }
        );
      }
    }

    // Fall back to local filesystem
    const folderPath = await getInvoiceFolderPath(ctx.tenantId);
    const signedPath = path.join(folderPath, "signed", decodedFilename);
    const resolved = path.resolve(signedPath);
    const resolvedFolder = path.resolve(folderPath);

    if (!resolved.startsWith(resolvedFolder)) {
      return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
    }

    if (!fs.existsSync(resolved)) {
      return NextResponse.json(
        { error: `Signed invoice "${decodedFilename}" not found` },
        { status: 404 }
      );
    }

    const buffer = fs.readFileSync(resolved);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="signed-${decodedFilename}"`,
        "Cache-Control": "no-cache",
      },
    });
  }

  const buffer = await readInvoiceFile(ctx.tenantId, decodedFilename);

  if (!buffer) {
    return NextResponse.json(
      { error: `Invoice "${decodedFilename}" not found` },
      { status: 404 }
    );
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${decodedFilename}"`,
      "Cache-Control": "no-cache",
    },
  });
});

export const PUT = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  const { id } = await params;
  const decodedFilename = decodeURIComponent(id);

  const body = await request.json();
  const { signatureImage, stopId, signerName } = body;

  if (!signatureImage) {
    return NextResponse.json(
      { error: "signatureImage (base64 data URL) is required" },
      { status: 400 }
    );
  }

  // If stopId provided, confirm it is in this scope (scoped read → 404 for a
  // stop belonging to another ADMIN).
  if (stopId) {
    const stop = await ctx.db.stop.findFirst({
      where: { id: stopId },
      include: { tripSheet: { select: { driverId: true } } },
    });
    if (!stop) {
      return NextResponse.json({ error: "Stop not found" }, { status: 404 });
    }
    // Drivers can only sign their own stops, within their own scope.
    if (ctx.role === "DRIVER") {
      const driver = await ctx.db.driver.findFirst({ where: { id: ctx.userId } });
      if (!driver || stop.tripSheet.driverId !== driver.id) {
        return NextResponse.json({ error: "Stop not found" }, { status: 404 });
      }
    }
  }

  const originalPdf = await readInvoiceFile(ctx.tenantId, decodedFilename);
  if (!originalPdf) {
    return NextResponse.json(
      { error: `Invoice file "${decodedFilename}" not found. It may have been renamed or moved.` },
      { status: 404 }
    );
  }

  const base64Data = signatureImage.replace(/^data:image\/png;base64,/, "");
  const signatureBytes = Uint8Array.from(Buffer.from(base64Data, "base64"));

  let signedPdfBuffer: Buffer;
  try {
    signedPdfBuffer = await embedSignatureOnPdf(
      ctx.tenantId,
      originalPdf,
      signatureBytes,
      signerName
    );
  } catch (err) {
    console.error("Failed to embed signature on PDF:", err);
    return NextResponse.json(
      { error: `Failed to embed signature on PDF: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }

  try {
    await saveSignedInvoice(
      ctx.tenantId,
      decodedFilename,
      signedPdfBuffer,
      true
    );
  } catch (err) {
    console.error("Failed to save signed invoice:", err);
    return NextResponse.json(
      { error: `Failed to save signed invoice: ${err instanceof Error ? err.message : "unknown error"}` },
      { status: 500 }
    );
  }

  if (stopId) {
    await updateStopStatus(ctx.tenantId, stopId, "SIGNED");
  }

  // Contact lookup / auto-create — within this scope only. A customer name that
  // matches another ADMIN's contact still gets a fresh contact here.
  let contactId: string | null = null;
  let contactHasEmail = false;

  if (stopId) {
    const stop = await ctx.db.stop.findFirst({ where: { id: stopId } });
    if (stop) {
      let contact = await ctx.db.contact.findFirst({
        where: { deletedAt: null, companyName: { equals: stop.customerName, mode: 'insensitive' } },
      });
      if (!contact) {
        contact = await ctx.db.contact.create({
          data: { companyName: stop.customerName, address: stop.address, source: 'AUTO_CREATED' },
        });
      }
      await ctx.db.stop.update({ where: { id: stopId }, data: { contactId: contact.id } });
      contactId = contact.id;
      contactHasEmail = !!contact.email;
    }
  }

  return NextResponse.json({
    success: true,
    contactId,
    contactHasEmail,
  });
});
