import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { getCourierSheet } from "@/lib/courier-import";
import { sendCourierConfirmation, type CourierEmailOutcome } from "@/lib/courier-confirm";

type Ctx = { params: Promise<{ id: string }> };

/** Attaching the signed copies reads each one from OneDrive. */
export const maxDuration = 60;

const STATUS: Partial<Record<CourierEmailOutcome, number>> = {
  not_found: 404,
  not_ready: 409,
  confirmed: 409,
  in_flight: 409,
};

const MESSAGE: Partial<Record<CourierEmailOutcome, string>> = {
  not_found: "Courier trip sheet not found",
  not_ready: "The email goes once the courier has signed and every signed copy is filed.",
  confirmed: "The customer has already confirmed this delivery.",
  in_flight: "The email is being sent right now.",
  no_email: "There is no email address for this customer — add one to their contact first.",
};

/**
 * The office's Send / Resend for the customer's email. ADMIN only.
 * Body: { force?: boolean } — force re-sends one already sent.
 */
export const POST = withAuth(async (request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await sendCourierConfirmation(ctx.tenantId, id, { force: body?.force === true, userName: ctx.name ?? null });
  const status = STATUS[result.outcome] ?? 200;
  if (status === 404) return NextResponse.json({ error: MESSAGE.not_found }, { status });
  return NextResponse.json(
    {
      ...result,
      success: result.outcome === "sent" || result.outcome === "already_sent",
      ...(MESSAGE[result.outcome] ? { error: MESSAGE[result.outcome] } : result.error ? { error: result.error } : {}),
      sheet: await getCourierSheet(ctx.tenantId, id),
    },
    { status }
  );
});
