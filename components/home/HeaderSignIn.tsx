"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { homePathForRole } from "@/lib/credentials";

/**
 * The header's one call to action. "Log in" for a visitor; for someone already
 * signed in, "Open Signex" straight to their own screen, so a driver who taps
 * the home-screen icon is never asked to log in again.
 */
export default function HeaderSignIn({ className = "" }: { className?: string }) {
  const [home, setHome] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((d) => {
        if (d.session?.role) setHome(homePathForRole(d.session.role));
      })
      .catch(() => {});
  }, []);

  return (
    <Link
      href={home ?? "/login"}
      className={`inline-flex items-center gap-2 rounded-lg bg-ink-green px-4 py-2.5 text-sm font-semibold text-[#0F0F0F] hover:bg-[#1fd896] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0F0F0F] ${className}`}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {home ? (
          <path d="M5 12h14M13 6l6 6-6 6" />
        ) : (
          <>
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <path d="m10 17 5-5-5-5" />
            <path d="M15 12H3" />
          </>
        )}
      </svg>
      {home ? "Open Signex" : "Log in"}
    </Link>
  );
}
