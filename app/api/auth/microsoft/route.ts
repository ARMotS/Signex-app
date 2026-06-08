import { NextResponse } from "next/server";
import { getAuthorizationUrl } from "@/lib/microsoft-graph";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import crypto from "crypto";

/**
 * GET /api/auth/microsoft
 * Initiates the OneDrive OAuth flow. Admin-only.
 * Returns a redirect URL to Microsoft's consent page.
 */
export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const state = crypto.randomBytes(16).toString("hex");
  const url = getAuthorizationUrl(state);

  return NextResponse.json({ url, state });
});
