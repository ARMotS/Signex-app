/**
 * app-url.ts
 * The address links in customer emails point at.
 *
 * A link in an email outlives the request that sent it and is opened on the
 * customer's own device, so it can never be built from a request's Host
 * header (a scheduled job has none) and must never come out as localhost.
 *
 * - Production: NEXT_PUBLIC_APP_URL when it holds a real address, else the
 *   production domain Vercel gives every deployment.
 * - A preview: that deployment's own address, so a test email opens the
 *   preview (which has the page) rather than production (which may not yet).
 * - Locally: NEXT_PUBLIC_APP_URL, else localhost.
 */

const isLocal = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url);
const withScheme = (host: string) => (/^https?:\/\//i.test(host) ? host : `https://${host}`);
const trimmed = (url: string) => url.trim().replace(/\/+$/, "");

export function appBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const configured = trimmed(env.NEXT_PUBLIC_APP_URL ?? "");

  if (env.VERCEL_ENV === "preview") {
    const preview = env.VERCEL_BRANCH_URL || env.VERCEL_URL;
    if (preview) return trimmed(withScheme(preview));
  }
  if (env.VERCEL_ENV === "production") {
    if (configured && !isLocal(configured)) return configured;
    if (env.VERCEL_PROJECT_PRODUCTION_URL) return trimmed(withScheme(env.VERCEL_PROJECT_PRODUCTION_URL));
  }
  return configured || "http://localhost:3000";
}
