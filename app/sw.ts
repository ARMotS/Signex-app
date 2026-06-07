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
    // App pages — stale-while-revalidate
    {
      matcher: ({ url }) =>
        /^\/(dashboard|run|select|sign|drivers|invoices|settings|trip-sheet)/.test(
          url.pathname
        ),
      handler: new StaleWhileRevalidate({
        cacheName: "signex-pages",
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
