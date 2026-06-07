import { NextResponse } from "next/server";
import { getSession, validateSessionToken, destroySession } from "@/lib/session";
import { getAdminCount } from "@/lib/accounts";

/**
 * GET /api/auth/session
 * Returns the current session info, or null if not logged in.
 * Validates session token against DB to enforce single-session per user.
 */
export async function GET() {
  try {
    const session = await getSession();
    const adminCount = await getAdminCount();

    if (session) {
      const isValid = await validateSessionToken(session);
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
