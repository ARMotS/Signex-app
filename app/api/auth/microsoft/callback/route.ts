import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, saveCloudAccount } from "@/lib/microsoft-graph";

/**
 * GET /api/auth/microsoft/callback
 * OAuth callback from Microsoft. Exchanges code for tokens and stores them.
 * Redirects back to settings page on success/failure.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
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

  try {
    const tokens = await exchangeCodeForTokens(code);
    await saveCloudAccount(tokens);
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
