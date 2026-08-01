"use client";

/**
 * Live updates by polling the change feed.
 *
 * Calls `onChange` whenever /api/sync reports that the caller's data has moved,
 * so a page can refetch only when there is something to refetch. Every guard
 * below exists because the alternative costs somebody something real:
 *
 *   - A HIDDEN tab does not poll. A driver's phone spends most of the shift in
 *     a pocket with the screen off; polling there burns battery and mobile data
 *     to learn nothing.
 *   - An OFFLINE device does not poll, and resumes the moment it reconnects.
 *   - Requests never STACK. A slow response on a bad connection must not queue
 *     a second request behind it — that is how a struggling phone turns into a
 *     stampede.
 *   - Errors BACK OFF exponentially, so an outage does not become a retry storm
 *     from a hundred devices at once.
 *
 * Waking on focus/visibility matters as much as the interval: the common case
 * is a driver pulling the phone out at a stop, and that should feel instant
 * rather than "up to twelve seconds stale".
 */

import { useEffect, useRef } from "react";

/** Chosen so a newly deployed trip sheet reaches a driver quickly. */
const DEFAULT_INTERVAL_MS = 12_000;

/** Ceiling for error backoff — an outage settles to one attempt a minute. */
const MAX_BACKOFF_MS = 60_000;

export interface UseLiveSyncOptions {
  /** Poll interval while the tab is visible and healthy. */
  intervalMs?: number;
  /** Set false to suspend entirely (e.g. before a driver has signed in). */
  enabled?: boolean;
}

export function useLiveSync(
  onChange: () => void,
  { intervalMs = DEFAULT_INTERVAL_MS, enabled = true }: UseLiveSyncOptions = {}
): void {
  // Held in a ref so a caller passing an inline arrow does not tear down and
  // rebuild the polling loop on every render. Assigned in an effect rather than
  // during render, which would be a side effect in the render phase.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor: string | null = null;
    let backoff = intervalMs;

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = (delay: number) => {
      clear();
      if (stopped) return;
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      if (stopped || inFlight) return;

      // Deliberately do NOT reschedule while hidden or offline — the listeners
      // below restart the loop on the event that makes polling useful again.
      if (document.hidden) return;
      if (!navigator.onLine) return;

      inFlight = true;
      try {
        const res = await fetch("/api/sync", { cache: "no-store" });

        // Respect the limiter rather than fighting it.
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get("Retry-After"));
          backoff = Math.min(
            MAX_BACKOFF_MS,
            retryAfter > 0 ? retryAfter * 1000 : backoff * 2
          );
          schedule(backoff);
          return;
        }

        // A signed-out session should stop polling, not spin on 401s. The
        // layout's own session check handles the redirect.
        if (res.status === 401 || res.status === 403) {
          stopped = true;
          return;
        }

        if (!res.ok) throw new Error(`sync ${res.status}`);

        const data: { cursor?: string } = await res.json();
        backoff = intervalMs;

        if (typeof data.cursor === "string") {
          if (cursor === null) {
            // First observation. The page loaded its own data moments ago, so
            // adopt the cursor rather than firing a redundant refetch.
            cursor = data.cursor;
          } else if (data.cursor !== cursor) {
            cursor = data.cursor;
            onChangeRef.current();
          }
        }

        schedule(intervalMs);
      } catch {
        backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
        schedule(backoff);
      } finally {
        inFlight = false;
      }
    };

    /** Something happened that makes a check worthwhile right now. */
    const wake = () => {
      if (stopped || document.hidden || !navigator.onLine) return;
      backoff = intervalMs;
      schedule(0);
    };

    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    // The offline queue just drained, so the server holds writes this tab has
    // not seen yet. Dispatched by lib/offline-sync.ts.
    window.addEventListener("signex:sync-complete", wake as EventListener);

    // First poll after one interval — the page has just fetched its data.
    schedule(intervalMs);

    return () => {
      stopped = true;
      clear();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("signex:sync-complete", wake as EventListener);
    };
  }, [enabled, intervalMs]);
}
