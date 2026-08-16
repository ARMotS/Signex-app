import { NextRequest, NextResponse } from 'next/server'
import { sendStopDeliveryConfirmation } from '@/lib/delivery-notify'
import { getScope } from '@/lib/tenant'
import { withAuth } from '@/lib/api-handler'

export const runtime = 'nodejs'

/**
 * Downloads the signed PDF as an attachment and waits on an SMTP relay, and the
 * dashboard's "Send all" walks the queue one at a time through this endpoint.
 */
export const maxDuration = 60

/**
 * The MANUAL send: a dispatcher on the dashboard, or a driver on the signature
 * screen, pushing a confirmation that did not go out by itself.
 *
 * The automatic send on signature is the normal path (see lib/delivery-notify.ts).
 * This exists for when that failed, when the customer had no address on file at
 * the time, or when someone asks for another copy.
 *
 * `[id]` is a STOP id, not an invoice filename. Resolved through the scoped
 * client, so a stop belonging to another ADMIN is not found — this endpoint
 * cannot be used to email another ADMIN's customer.
 */
export const POST = withAuth(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await getScope();
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const { driverName } = body ?? {};
  // Pressing Send by hand means "send it now", including a second copy of one
  // that already went. An attempt already in flight is still not duplicated.
  const force = body?.force !== false;

  const result = await sendStopDeliveryConfirmation(ctx.tenantId, id, {
    driverName: typeof driverName === 'string' ? driverName : undefined,
    force,
  });

  switch (result.outcome) {
    case 'not_signed':
      // 404 covers both "no such stop" and "not yours". A stop that exists but
      // is unsigned is a 400 the caller can act on.
      return NextResponse.json({ error: 'Stop not found or not signed yet' }, { status: 404 });
    case 'no_email':
      return NextResponse.json({ skipped: true, reason: 'No email on file' });
    case 'in_flight':
      return NextResponse.json({
        skipped: true,
        reason: 'A confirmation for this delivery is already being sent',
      });
    case 'failed':
      return NextResponse.json({ success: false, error: result.error }, { status: 502 });
    default:
      return NextResponse.json({ success: true, recipient: result.recipient });
  }
});
