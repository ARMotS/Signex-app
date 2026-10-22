import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { CourierError, readCourierOriginal, storeCourierOriginal } from "@/lib/courier-import";

type Ctx = { params: Promise<{ id: string }> };

/** The courier trip sheet's original Excel, as uploaded. ADMIN only. */
export const GET = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const original = await readCourierOriginal(ctx.tenantId, id);
  if (!original) return NextResponse.json({ error: "Original sheet not found" }, { status: 404 });

  const xls = /\.xls$/i.test(original.filename);
  return new NextResponse(new Uint8Array(original.buffer), {
    headers: {
      "Content-Type": xls ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${original.filename.replace(/["\\\r\n]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
});

/** Retry filing the original in Courier Trip Sheets/ after it failed. */
export const POST = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;
  try {
    const result = await storeCourierOriginal(ctx.tenantId, id, ctx.name ?? null);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (err) {
    if (err instanceof CourierError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
});
