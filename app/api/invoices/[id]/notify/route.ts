import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { sendDeliveryConfirmation } from '@/lib/email'
import { getSessionContext } from '@/lib/tenant'
import { withAuth } from '@/lib/api-handler'
import { getInvoiceFolderPath } from '@/lib/invoices'
import { getOneDriveInvoiceSource, listOneDriveSignedInvoices, downloadFileById } from '@/lib/microsoft-graph'

export const runtime = 'nodejs'

export const POST = withAuth(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getSessionContext();
  const { id } = await params;
  const { driverName } = await req.json();

  const stop = await prisma.stop.findUnique({
    where: { id },
    include: { contact: true },
  });

  if (!stop || stop.tenantId !== ctx.tenantId) {
    return NextResponse.json({ error: 'Stop not found' }, { status: 404 });
  }
  if (stop.status !== 'SIGNED') return NextResponse.json({ error: 'Invoice not signed yet' }, { status: 400 });
  if (!stop.contact?.email) return NextResponse.json({ skipped: true, reason: 'No email on file' });

  const signedPDFUrl = '';

  // Read signed PDF for attachment (OneDrive or local)
  let pdfAttachment: { filename: string; content: Buffer } | undefined;
  if (stop.invoiceFile) {
    try {
      const onedrive = await getOneDriveInvoiceSource();
      if (onedrive) {
        const signedItems = await listOneDriveSignedInvoices();
        const match = signedItems.find((i) => i.name === stop.invoiceFile);
        if (match) {
          pdfAttachment = {
            filename: `signed-${stop.invoiceFile}`,
            content: await downloadFileById(match.id),
          };
        }
      } else {
        const folderPath = await getInvoiceFolderPath();
        const signedPath = path.join(folderPath, 'signed', stop.invoiceFile);
        if (fs.existsSync(signedPath)) {
          pdfAttachment = {
            filename: `signed-${stop.invoiceFile}`,
            content: fs.readFileSync(signedPath),
          };
        }
      }
    } catch (err) {
      console.error('[notify] Failed to read signed PDF for attachment:', err);
    }
  }

  const result = await sendDeliveryConfirmation({
    customerEmail: stop.contact.email,
    customerName: stop.contact.companyName,
    contactPerson: stop.contact.contactPerson ?? undefined,
    invoiceNumber: stop.invoiceNumber,
    driverName,
    deliveryAddress: stop.address,
    signedAt: stop.signedAt ?? new Date(),
    signedPDFUrl,
    companyName: process.env.COMPANY_NAME ?? 'Signex',
    pdfAttachment,
  });

  if (result.success) {
    await prisma.stop.update({
      where: { id },
      data: { emailSentAt: new Date() },
    });
  }

  return NextResponse.json(result);
});
