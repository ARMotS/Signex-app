import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { readInvoiceFile, saveSignedInvoice, embedSignatureOnPdf, getInvoiceFolderPath } from "@/lib/invoices";
import { updateStopStatus } from "@/lib/trip-data";
import { prisma } from "@/lib/db";
import { getSessionContext } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getSessionContext();
  const { id } = await params;
  const decodedFilename = decodeURIComponent(id);
  const { searchParams } = new URL(request.url);
  const wantSigned = searchParams.get("signed") === "true";

  if (wantSigned) {
    const folderPath = await getInvoiceFolderPath();
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

  const buffer = await readInvoiceFile(decodedFilename);

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
  const ctx = await getSessionContext();
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

  // If stopId provided, verify it belongs to this tenant
  if (stopId) {
    const stop = await prisma.stop.findUnique({
      where: { id: stopId },
      include: { tripSheet: { select: { driverId: true } } },
    });
    if (!stop || stop.tenantId !== ctx.tenantId) {
      return NextResponse.json({ error: "Stop not found" }, { status: 404 });
    }
    // Drivers can only sign their own stops
    if (ctx.role === "DRIVER") {
      const driver = await prisma.driver.findFirst({
        where: { id: ctx.userId, tenantId: ctx.tenantId },
      });
      if (!driver || stop.tripSheet.driverId !== driver.id) {
        return NextResponse.json({ error: "Stop not found" }, { status: 404 });
      }
    }
  }

  const originalPdf = await readInvoiceFile(decodedFilename);
  if (!originalPdf) {
    return NextResponse.json(
      { error: `Invoice "${decodedFilename}" not found` },
      { status: 404 }
    );
  }

  const base64Data = signatureImage.replace(/^data:image\/png;base64,/, "");
  const signatureBytes = Uint8Array.from(Buffer.from(base64Data, "base64"));

  const signedPdfBuffer = await embedSignatureOnPdf(
    originalPdf,
    signatureBytes,
    signerName
  );

  await saveSignedInvoice(
    decodedFilename,
    signedPdfBuffer,
    true
  );

  if (stopId) {
    await updateStopStatus(stopId, "SIGNED");
  }

  // Contact lookup / auto-create
  let contactId: string | null = null;
  let contactHasEmail = false;

  if (stopId) {
    const stop = await prisma.stop.findUnique({ where: { id: stopId } });
    if (stop) {
      let contact = await prisma.contact.findFirst({
        where: { tenantId: ctx.tenantId, deletedAt: null, companyName: { equals: stop.customerName, mode: 'insensitive' } },
      });
      if (!contact) {
        contact = await prisma.contact.create({
          data: { tenantId: ctx.tenantId, companyName: stop.customerName, address: stop.address, source: 'AUTO_CREATED' },
        });
      }
      await prisma.stop.update({ where: { id: stopId }, data: { contactId: contact.id } });
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
