import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { queryAuditLogs } from "@/lib/audit";
import { readDispatchCompany } from "@/lib/config";
import { scheduleCourierConfirmation } from "@/lib/courier-confirm";
import {
  CourierError,
  deleteCourierSheet,
  getCourierSheet,
  linkCourierContact,
  recheckCourierSheet,
  removeCourierInvoice,
} from "@/lib/courier-import";

type Ctx = { params: Promise<{ id: string }> };

/** Re-checking lists the invoice folder. */
export const maxDuration = 60;

const asResponse = (err: unknown) => {
  if (err instanceof CourierError) {
    return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
  }
  throw err;
};

// Every read is scoped: another ADMIN's sheet is not found, the same 404 as
// an id that exists nowhere.
export const GET = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;

  const sheet = await getCourierSheet(ctx.tenantId, id);
  if (!sheet) return NextResponse.json({ error: "Courier trip sheet not found" }, { status: 404 });
  const [{ logs }, dispatchCompany] = await Promise.all([
    queryAuditLogs(ctx.tenantId, { entity: "courier_sheet", entityId: id, limit: 100 }),
    readDispatchCompany(ctx.tenantId),
  ]);
  return NextResponse.json({
    sheet,
    audit: logs.map((l) => ({ action: l.action, userName: l.userName, details: l.details, createdAt: l.createdAt })),
    // What Collect & Sign is prefilled with: the dispatcher is whoever is
    // signed in (editable), the company is the branch's (not editable).
    signer: { dispatcherName: ctx.name ?? "", dispatchCompany },
  });
});

/**
 * The office's actions on a sheet the courier has not signed for yet
 * (linkContact also after, for the confirmation email):
 *   { action: "recheck" }
 *   { action: "linkContact", contactId }
 *   { action: "removeInvoice", lineId }
 */
export const PUT = withAuth(async (request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const who = ctx.name ?? null;

  try {
    switch (body?.action) {
      case "recheck":
        if (!(await getCourierSheet(ctx.tenantId, id))) throw new CourierError("NOT_FOUND", "Courier trip sheet not found", 404);
        await recheckCourierSheet(ctx.tenantId, id, who);
        break;
      case "linkContact":
        if (typeof body.contactId !== "string") throw new CourierError("BAD_REQUEST", "Choose a contact.", 400);
        // After the handover the contact is where the email goes: send it
        // now if it was waiting for an address (a no-op otherwise).
        if ((await linkCourierContact(ctx.tenantId, id, body.contactId, who)).status === "COLLECTED") {
          await scheduleCourierConfirmation(ctx.tenantId, id);
        }
        break;
      case "removeInvoice":
        if (typeof body.lineId !== "string") throw new CourierError("BAD_REQUEST", "Choose an invoice.", 400);
        await removeCourierInvoice(ctx.tenantId, id, body.lineId, who);
        break;
      default:
        throw new CourierError("BAD_REQUEST", "Unknown action.", 400);
    }
  } catch (err) {
    return asResponse(err);
  }
  return NextResponse.json({ sheet: await getCourierSheet(ctx.tenantId, id) });
});

export const DELETE = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;
  try {
    await deleteCourierSheet(ctx.tenantId, id, ctx.name ?? null);
  } catch (err) {
    return asResponse(err);
  }
  return NextResponse.json({ success: true });
});
