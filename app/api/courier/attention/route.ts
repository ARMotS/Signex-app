import { NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { courierOverview } from "@/lib/courier-confirm";

/**
 * The Courier nav badge: how many courier sheets need the office (something
 * to fix before the handover, copies not filed, an email that did not go, a
 * customer who has not answered the reminder). ADMIN only, scoped.
 */
export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { attention } = await courierOverview(ctx.tenantId, new Date());
  return NextResponse.json({ attention });
});
