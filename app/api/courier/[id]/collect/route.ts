import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { CourierError, getCourierSheet } from "@/lib/courier-import";
import { collectCourierSheet, readCollectInput } from "@/lib/courier-collect";

type Ctx = { params: Promise<{ id: string }> };

/** Stamping and filing one signed copy per invoice. */
export const maxDuration = 60;

/**
 * Collect & Sign: the courier driver signs for the sheet at the office.
 * ADMIN only — the courier driver has no account; the logged-in dispatcher
 * operates the screen. Body: lib/courier-collect.ts CollectInput.
 */
export const POST = withAuth(async (request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { id } = await params;

  const read = readCollectInput(await request.json().catch(() => null));
  if (!read.ok) return NextResponse.json({ error: read.errors[0], errors: read.errors }, { status: 400 });

  try {
    const filing = await collectCourierSheet(ctx.tenantId, id, read.input, { userId: ctx.userId, name: ctx.name ?? null });
    return NextResponse.json({ filing, sheet: await getCourierSheet(ctx.tenantId, id) });
  } catch (err) {
    if (err instanceof CourierError) {
      return NextResponse.json({ error: err.message, code: err.code, ...err.extra }, { status: err.status });
    }
    throw err;
  }
});
