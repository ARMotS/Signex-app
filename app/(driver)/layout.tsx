"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function DriverLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();

  useEffect(() => {
    const checkSession = () => {
      fetch("/api/auth/session")
        .then((r) => r.json())
        .then((data) => {
          if (data.kicked || !data.session) {
            localStorage.removeItem("signex-driver");
            router.replace("/select");
          }
        })
        .catch(() => {});
    };

    checkSession();
    const interval = setInterval(checkSession, 30000);
    return () => clearInterval(interval);
  }, [router]);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    localStorage.removeItem("signex-driver");
    router.replace("/select");
  };

  return (
    <div className="min-h-dvh flex flex-col bg-ink-surface">
      {/* Minimal top bar */}
      <header className="flex items-center justify-between px-4 py-3 bg-ink-card border-b border-ink-border safe-top">
        <Link
          href="/"
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <div className="w-7 h-7 bg-ink-black rounded flex items-center justify-center">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#00C07F"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </div>
          <span className="font-mono text-sm font-medium text-ink-black tracking-tight">
            SIGNEX
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <Link
            href="/select"
            className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
          >
            Switch Driver
          </Link>
          <button
            onClick={handleLogout}
            className="text-xs font-mono px-2 py-1 text-ink-muted hover:text-ink-red transition-colors"
            title="Sign out"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-ink-green-dim text-ink-green uppercase tracking-wider">
            Driver
          </span>
        </div>
      </header>

      {/* Content area with safe-area bottom padding */}
      <main className="flex-1 flex flex-col safe-bottom">{children}</main>
    </div>
  );
}
