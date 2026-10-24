import { NextResponse } from "next/server";
import { destroySession, peekSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";

/**
 * POST /api/auth/logout
 * Destroys the current session.
 */
export async function POST() {
  try {
    // Logged before the cookie goes, while the request still says who it is.
    const session = await peekSession();
    if (session) {
      await logAudit({
        action: "LOGOUT",
        entity: session.role === "driver" ? "driver" : "admin",
        entityId: session.id,
        userName: session.name,
        details: "Signed out",
        tenantId: session.tenantId ?? null,
      });
    }
    await destroySession();
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { error: "Failed to logout" },
      { status: 500 }
    );
  }
}
