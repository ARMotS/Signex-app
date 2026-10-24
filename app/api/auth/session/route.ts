import { NextResponse } from "next/server";
import { getSession, validateSession, destroySession } from "@/lib/session";
import { getAdminCount } from "@/lib/accounts";

/**
 * GET /api/auth/session
 * Returns the current session info, or null if not logged in.
 * Validates the session against its UserSession row, so a revoked or evicted
 * session (see SESSION_LIMITS) is signed out and its cookie cleared.
 */
export async function GET() {
  try {
    const session = await getSession();
    const adminCount = await getAdminCount();

    if (session) {
      const isValid = await validateSession(session);
      if (!isValid) {
        await destroySession();
        return NextResponse.json({
          session: null,
          needsSetup: adminCount === 0,
          kicked: true,
        });
      }
    }

    return NextResponse.json({
      session,
      needsSetup: adminCount === 0,
    });
  } catch (error) {
    console.error("Session check error:", error);
    return NextResponse.json({ session: null, needsSetup: false });
  }
}
