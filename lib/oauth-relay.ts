/**
 * Hand a OneDrive OAuth round-trip back to the deployment that started it.
 *
 * Microsoft redirects only to a registered callback URL, and that is the
 * production one (`MICROSOFT_REDIRECT_URI`). A connect begun on a Vercel preview
 * therefore came back to production: the preview's session never saw the code,
 * and the admin was left on the production site with nothing connected.
 *
 * The flow now records its origin inside the signed `state`. When production's
 * callback receives a state minted elsewhere it forwards the request, query
 * intact, to that origin's own callback, which runs every check itself (session,
 * signature, scope match) and exchanges the code there. The exchange still sends
 * the production redirect URI, so it matches what was authorized.
 *
 * Two guards keep this from being an open redirect:
 *   1. The origin is only read from a state whose HMAC verifies — a deployment
 *      holding SESSION_SECRET wrote it, from its own request URL.
 *   2. The origin must be a Vercel deployment or local dev, or be listed in
 *      `OAUTH_RETURN_ORIGINS` (comma-separated, exact origins).
 *
 * Even a misdirected code is inert on its own: redeeming it needs the client
 * secret and the registered redirect URI.
 */

import { verifyOAuthState } from "./crypto";

export function isRelayableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // Only a bare origin — no path, credentials or query smuggled in.
  if (url.origin !== origin) return false;

  const listed = (process.env.OAUTH_RETURN_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (listed.includes(origin)) return true;

  if (url.protocol === "https:" && url.hostname.endsWith(".vercel.app")) return true;
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  ) {
    return true;
  }
  return false;
}

/**
 * The origin this callback should forward to, or null to handle it here.
 * `currentOrigin` is the origin the callback request arrived on.
 */
export function oauthRelayOrigin(
  currentOrigin: string,
  state: string | null
): string | null {
  const verified = verifyOAuthState(state);
  const target = verified?.returnOrigin;
  if (!target || target === currentOrigin) return null;
  return isRelayableOrigin(target) ? target : null;
}
