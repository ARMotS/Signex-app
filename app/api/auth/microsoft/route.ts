import { NextResponse } from "next/server";
import { getAuthorizationUrl } from "@/lib/microsoft-graph";
import { signOAuthState } from "@/lib/crypto";
import { getScope, requireRole, requireHomeScope } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * GET /api/auth/microsoft
 * Initiates the OneDrive OAuth flow. Admin-only.
 * Returns a redirect URL to Microsoft's consent page.
 *
 * `state` is an HMAC-signed token binding this round-trip to the caller's scope,
 * verified in the callback. Previously it was a bare random value returned to the
 * client and never checked on the way back.
 */
export const GET = withAuth(async (req) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  // Connecting a drive is an act of ownership — a SUPER_ADMIN must not attach
  // their own Microsoft account while viewing someone else's scope.
  requireHomeScope(ctx);

  // Our own origin rides in the signed state so production's callback can hand
  // a preview deployment's round-trip back to it (lib/oauth-relay.ts).
  const state = signOAuthState(ctx.tenantId, req.nextUrl.origin);
  const url = getAuthorizationUrl(state);

  return NextResponse.json({ url, state });
});
