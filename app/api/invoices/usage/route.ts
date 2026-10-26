import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { findInvoiceTripUsage } from "@/lib/stop-removal";

/** Upper bound on one lookup; the Invoices page selects at most a page or two. */
const MAX_FILENAMES = 500;

/**
 * Which live trip sheets use these invoice files — read by the Invoices page
 * before it deletes anything, so the warning can name the drivers and stops a
 * delete would take off the road. POST because the list can be long.
 */
export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireOffice(ctx);

  const body = await request.json().catch(() => ({}));
  const filenames: unknown = body?.filenames;
  if (!Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json({ error: "filenames array is required" }, { status: 400 });
  }
  if (filenames.length > MAX_FILENAMES) {
    return NextResponse.json(
      { error: `At most ${MAX_FILENAMES} files at a time` },
      { status: 400 }
    );
  }

  const usage = await findInvoiceTripUsage(
    ctx.tenantId,
    filenames.filter((f): f is string => typeof f === "string")
  );
  return NextResponse.json({ usage });
});
