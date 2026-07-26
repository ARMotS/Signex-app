import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { sendDeliveryConfirmation } from '@/lib/email'
import { getScope } from '@/lib/tenant'
import { withAuth } from '@/lib/api-handler'
import { getInvoiceFolderPath } from '@/lib/invoices'
import { getOneDriveInvoiceSource, listOneDriveSignedInvoices, downloadFileById } from '@/lib/microsoft-graph'

export const runtime = 'nodejs'

export const POST = withAuth(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getScope();
  const { id } = await params;
  const { driverName } = await req.json();

  // Scoped read — a stop id from another ADMIN is not found, so this endpoint
  // cannot be used to email another ADMIN's customer.
  const stop = await ctx.db.stop.findFirst({
    where: { id },
    include: { contact: true },
  });

  if (!stop) {
    return NextResponse.json({ error: 'Stop not found' }, { status: 404 });
  }
  if (stop.status !== 'SIGNED') return NextResponse.json({ error: 'Invoice not signed yet' }, { status: 400 });
  if (!stop.contact?.email) return NextResponse.json({ skipped: true, reason: 'No email on file' });

  const signedPDFUrl = '';

  // Read signed PDF for attachment (OneDrive or local)
  let pdfAttachment: { filename: string; content: Buffer } | undefined;
  if (stop.invoiceFile) {
    try {
      const onedrive = await getOneDriveInvoiceSource(ctx.tenantId);
      if (onedrive) {
        const signedItems = await listOneDriveSignedInvoices(ctx.tenantId);
        const match = signedItems.find((i) => i.name === stop.invoiceFile);
        if (match) {
          pdfAttachment = {
            filename: `signed-${stop.invoiceFile}`,
            content: await downloadFileById(ctx.tenantId, match.id),
          };
        }
      } else {
        const folderPath = await getInvoiceFolderPath(ctx.tenantId);
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
    await ctx.db.stop.update({
      where: { id },
      data: { emailSentAt: new Date() },
    });
  }

  return NextResponse.json(result);
});
