/**
 * Signex Service Worker — powered by Serwist.
 *
 * Handles:
 * - Precaching of Next.js build assets (auto-injected by @serwist/next)
 * - Runtime caching strategies for API calls, pages, and static assets
 * - Background sync for offline signature operations
 */

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist, CacheFirst, NetworkFirst, StaleWhileRevalidate, ExpirationPlugin } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: WorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // API calls — network first with 10s timeout, cache fallback
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/"),
      handler: new NetworkFirst({
        cacheName: "signex-api-cache",
        networkTimeoutSeconds: 10,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 100,
            maxAgeSeconds: 24 * 60 * 60, // 1 day
          }),
        ],
      }),
    },
    // Static assets — cache first, long expiry
    {
      matcher: ({ url }) =>
        /\.(png|jpg|jpeg|svg|gif|webp|ico|woff2?)$/.test(url.pathname),
      handler: new CacheFirst({
        cacheName: "signex-static-assets",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 200,
            maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
          }),
        ],
      }),
    },
    // Entry points — always network first.
    //
    // /select/<slug> is the per-operator driver sign-in link and /login is the
    // admin one. These must never be served from a stale cache: a phone that had
    // cached this app before /select/<slug> existed would resolve the navigation
    // against its old route manifest and land on bare /select instead, which is
    // exactly the "your link doesn't work" symptom. Auth entry points are also the
    // last place a day-old response is acceptable.
    {
      matcher: ({ url }) => /^\/(select|login)(\/|$)/.test(url.pathname),
      handler: new NetworkFirst({
        cacheName: "signex-entry-v2",
        networkTimeoutSeconds: 10,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 10,
            maxAgeSeconds: 60 * 60, // 1 hour
          }),
        ],
      }),
    },
    // Remaining app pages — stale-while-revalidate.
    //
    // Cache name is versioned: renaming it discards entries written by an earlier
    // deployment instead of revalidating them, which is what lets a route added
    // after a phone last loaded the app actually resolve.
    //
    // BUMP THIS WHENEVER A DRIVER-FACING PAGE CHANGES MEANINGFULLY. Under
    // stale-while-revalidate a phone serves the cached page first and only picks
    // up the new one on the load AFTER that, so a behavioural change appears not
    // to have deployed at all. v3: the signature screen lost its send-email
    // button when confirmations became automatic, and drivers kept seeing — and
    // pressing — the old one.
    {
      matcher: ({ url }) =>
        /^\/(dashboard|run|sign|drivers|contacts|invoices|settings|trip-sheet|backups|users)/.test(
          url.pathname
        ),
      handler: new StaleWhileRevalidate({
        cacheName: "signex-pages-v3",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 30,
            maxAgeSeconds: 24 * 60 * 60, // 1 day
          }),
        ],
      }),
    },
    // Default cache rules from Serwist for everything else
    ...defaultCache,
  ],
});

serwist.addEventListeners();

/**
 * Drop runtime caches this service worker no longer uses.
 *
 * Serwist's precache is versioned automatically, but runtime caches are not — a
 * renamed cache leaves the old one on disk, still holding responses from an
 * earlier deployment. Without this, a phone that cached the app before
 * /select/<slug> existed would keep serving the stale pages that made the driver
 * sign-in link appear broken.
 *
 * Anything not named here is deleted on activation. With skipWaiting and
 * clientsClaim already set, that happens on the user's next load.
 */
const EXPECTED_RUNTIME_CACHES = new Set([
  "signex-api-cache",
  "signex-static-assets",
  "signex-entry-v2",
  "signex-pages-v3",
]);

self.addEventListener("activate", (event) => {
  (event as ExtendableEvent).waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("signex-") && !EXPECTED_RUNTIME_CACHES.has(name)
          )
          .map((name) => caches.delete(name))
      );
    })()
  );
});
