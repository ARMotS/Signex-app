import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { sendCreditNoteEmail, type CreditEmailOutcome } from "@/lib/credit-note-email";

type Ctx = { params: Promise<{ id: string }> };

/** Attaching the signed copy reads it from OneDrive. */
export const maxDuration = 60;

const STATUS: Partial<Record<CreditEmailOutcome, number>> = {
  not_found: 404,
  not_ready: 409,
  in_flight: 409,
};

const MESSAGE: Partial<Record<CreditEmailOutcome, string>> = {
  not_found: "Credit note not found",
  not_ready: "The email goes once the note is signed and its signed copy is filed.",
  in_flight: "The email is being sent right now.",
  no_email: "There is no email address for this customer — add one to their contact first.",
};

/**
 * POST /api/credit-notes/[id]/notify — the office's Send / Resend of the
 * customer's copy of a signed credit note. Body: { force?: boolean } — force
 * re-sends one already sent (never one being sent right now).
 *
 * ADMIN only; another scope's note is 404 through the scoped client, so its
 * customer can never be emailed from here.
 */
export const POST = withAuth(async (request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));

  const result = await sendCreditNoteEmail(ctx.tenantId, id, { force: body?.force === true, userName: ctx.name ?? null });
  const status = STATUS[result.outcome] ?? 200;
  if (status === 404) return NextResponse.json({ error: MESSAGE.not_found }, { status });
  return NextResponse.json(
    {
      ...result,
      success: result.outcome === "sent" || result.outcome === "already_sent",
      ...(MESSAGE[result.outcome] ? { error: MESSAGE[result.outcome] } : result.error ? { error: result.error } : {}),
    },
    { status }
  );
});
