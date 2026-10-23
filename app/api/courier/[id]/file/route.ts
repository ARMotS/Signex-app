import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { CourierError, getCourierSheet } from "@/lib/courier-import";
import { fileCourierSheet } from "@/lib/courier-collect";

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 60;

/** "Retry filing": stamp and file the signed copies not filed yet. ADMIN only. */
export const POST = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  try {
    const filing = await fileCourierSheet(ctx.tenantId, id, ctx.name ?? null);
    return NextResponse.json({ filing, sheet: await getCourierSheet(ctx.tenantId, id) });
  } catch (err) {
    if (err instanceof CourierError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
});
