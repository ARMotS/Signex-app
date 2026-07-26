import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, saveCloudAccount } from "@/lib/microsoft-graph";
import { verifyOAuthState } from "@/lib/crypto";
import { getSessionContext } from "@/lib/tenant";

/**
 * GET /api/auth/microsoft/callback
 * OAuth callback from Microsoft. Exchanges code for tokens and stores them
 * against the scope the flow was started from.
 *
 * Three checks that were previously absent:
 *   1. An authenticated ADMIN session is required. Without it, anyone able to
 *      reach this URL with a `code` could write the stored OneDrive connection.
 *   2. `state` must carry a valid, unexpired HMAC signature.
 *   3. The scope inside `state` must match the session's scope, so a signed state
 *      issued for one ADMIN cannot be replayed to plant tokens on another.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  const settingsUrl = new URL("/settings", request.url);

  if (error) {
    settingsUrl.searchParams.set("cloud_error", errorDescription || error);
    return NextResponse.redirect(settingsUrl);
  }

  if (!code) {
    settingsUrl.searchParams.set("cloud_error", "No authorization code received");
    return NextResponse.redirect(settingsUrl);
  }

  // 1. Require an admin session.
  let ctx;
  try {
    ctx = await getSessionContext();
  } catch {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (ctx.role !== "ADMIN" && ctx.role !== "SUPER_ADMIN") {
    settingsUrl.searchParams.set("cloud_error", "Not authorized");
    return NextResponse.redirect(settingsUrl);
  }

  // 2 + 3. Verify the state signature and that it was issued for this scope.
  const verified = verifyOAuthState(state);
  if (!verified || verified.tenantId !== ctx.homeTenantId) {
    settingsUrl.searchParams.set(
      "cloud_error",
      "Authorization request could not be verified. Please try connecting again."
    );
    return NextResponse.redirect(settingsUrl);
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    // Stored encrypted, against this scope only.
    await saveCloudAccount(verified.tenantId, tokens);
    settingsUrl.searchParams.set("cloud_connected", "true");
    return NextResponse.redirect(settingsUrl);
  } catch (err) {
    console.error("OneDrive OAuth callback error:", err);
    settingsUrl.searchParams.set(
      "cloud_error",
      err instanceof Error ? err.message : "Failed to connect OneDrive"
    );
    return NextResponse.redirect(settingsUrl);
  }
}
