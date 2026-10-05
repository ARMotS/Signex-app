import { redirect } from "next/navigation";

/**
 * Retired. Drivers used to sign in here — by picking their name from a
 * per-company link (/select/<slug>) and entering a PIN. Every role now signs in
 * with a username and password at /login.
 *
 * Kept as a redirect (/select/<anything> is redirected in middleware.ts) so
 * bookmarks and home-screen shortcuts on drivers' phones still land somewhere
 * useful.
 */
export default function RetiredDriverSelectPage() {
  redirect("/login");
}
