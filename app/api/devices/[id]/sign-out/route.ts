import { NextRequest, NextResponse } from "next/server";
import { getSessionContext } from "@/lib/tenant";
import { getSession, hashSessionToken } from "@/lib/session";
import { withAuth } from "@/lib/api-handler";
import { DeviceError, signOutDevice } from "@/lib/devices";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/devices/[id]/sign-out — sign one device (a session id) out. Only
 * for an account the caller may see (lib/devices.ts); anything else is 404,
 * and the caller's own current device is 400 (that is Log out).
 */
export const POST = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getSessionContext();
  const { id } = await params;
  const session = await getSession();
  try {
    const result = await signOutDevice(ctx, id, session ? hashSessionToken(session.sessionToken) : null);
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    if (err instanceof DeviceError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    throw err;
  }
});
