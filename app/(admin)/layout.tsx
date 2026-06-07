"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";

const navItems = [
  {
    label: "Dashboard",
    href: "/dashboard",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </svg>
    ),
  },
  {
    label: "Drivers",
    href: "/drivers",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    label: "Contacts",
    href: "/contacts",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        <line x1="19" y1="8" x2="23" y2="8" />
        <line x1="21" y1="6" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    label: "Trip Sheet",
    href: "/trip-sheet",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
        <path d="M10 9H8" />
      </svg>
    ),
  },
  {
    label: "Invoices",
    href: "/invoices",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20" />
      </svg>
    ),
  },
  {
    label: "Backups",
    href: "/backups",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    ),
  },
  {
    label: "Settings",
    href: "/settings",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<{ name: string; email?: string } | null>(null);

  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    const checkSession = () => {
      fetch("/api/auth/session")
        .then((r) => r.json())
        .then((data) => {
          if (data.kicked || !data.session) {
            router.replace("/login");
            return;
          }
          if (data.session.role === "admin" || data.session.role === "super_admin") {
            setSession({ name: data.session.name, email: data.session.email });
            setRole(data.session.role);
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
    router.replace("/login");
  };

  return (
    <div className="flex min-h-dvh">
      {/* ─── Sidebar ─────────────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 flex-col bg-sidebar-bg border-r border-white/5 shrink-0 fixed top-0 left-0 h-dvh z-40">
        {/* Logo — links to home */}
        <Link href="/" className="flex items-center gap-2 px-5 py-5 border-b border-white/5 hover:bg-white/5 transition-colors">
          <div className="w-7 h-7 bg-ink-green/10 rounded flex items-center justify-center">
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
          <span className="font-mono text-sm font-medium tracking-tight text-sidebar-text-active">
            SIGNEX
          </span>
          <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-sidebar-text">
            ADMIN
          </span>
        </Link>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded text-sm font-mono transition-colors ${
                  isActive
                    ? "bg-white/8 text-sidebar-text-active"
                    : "text-sidebar-text hover:bg-white/5 hover:text-sidebar-text-active"
                }`}
              >
                <span
                  className={isActive ? "text-ink-green" : "text-sidebar-text"}
                >
                  {item.icon}
                </span>
                {item.label}
                {isActive && (
                  <span className="ml-auto w-1.5 h-1.5 rounded-full bg-ink-green" />
                )}
              </Link>
            );
          })}
          {role === "super_admin" && (
            <Link
              href="/users"
              className={`flex items-center gap-3 px-3 py-2.5 rounded text-sm font-mono transition-colors ${
                pathname === "/users"
                  ? "bg-white/8 text-sidebar-text-active"
                  : "text-sidebar-text hover:bg-white/5 hover:text-sidebar-text-active"
              }`}
            >
              <span className={pathname === "/users" ? "text-ink-green" : "text-sidebar-text"}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </span>
              Users
              {pathname === "/users" && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-ink-green" />
              )}
            </Link>
          )}
        </nav>

        {/* Quick links */}
        <div className="px-3 py-3 border-t border-white/5">
          <Link
            href="/select"
            className="flex items-center gap-3 px-3 py-2.5 rounded text-sm font-mono text-sidebar-text hover:bg-white/5 hover:text-sidebar-text-active transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <polyline points="10 17 15 12 10 7" />
              <line x1="15" y1="12" x2="3" y2="12" />
            </svg>
            Driver App
          </Link>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded bg-white/10 flex items-center justify-center">
              <span className="text-xs font-mono text-sidebar-text">
                {session?.name?.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "AD"}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-sidebar-text-active truncate">
                {session?.name || "Admin"}
              </p>
              <p className="text-[10px] text-sidebar-text truncate">
                {session?.email || "Not signed in"}
              </p>
            </div>
            <button
              onClick={handleLogout}
              title="Sign out"
              className="w-7 h-7 rounded flex items-center justify-center hover:bg-white/10 transition-colors text-sidebar-text hover:text-ink-red"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ─── Mobile Header ───────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col min-w-0 md:ml-56">
        <header className="md:hidden flex items-center justify-between px-4 py-3 bg-ink-card border-b border-ink-border">
          <Link href="/" className="flex items-center gap-2">
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
            <span className="font-mono text-sm font-medium text-ink-black">
              SIGNEX
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              href="/select"
              className="text-xs font-mono px-3 py-1.5 rounded bg-ink-green-dim text-ink-green hover:bg-ink-green hover:text-white transition-all"
            >
              Driver App →
            </Link>
            <button
              onClick={handleLogout}
              className="w-8 h-8 flex items-center justify-center rounded hover:bg-ink-surface transition-colors text-ink-muted"
              title="Sign out"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </header>

        {/* Mobile bottom nav */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 bg-ink-card border-t border-ink-border z-50 safe-bottom">
          <nav className="flex items-center justify-around py-2">
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded transition-colors touch-target ${
                    isActive ? "text-ink-green" : "text-ink-muted"
                  }`}
                >
                  {item.icon}
                  <span className="text-[10px] font-mono">{item.label}</span>
                </Link>
              );
            })}
            {role === "super_admin" && (
              <Link
                href="/users"
                className={`flex flex-col items-center gap-1 px-3 py-1.5 rounded transition-colors touch-target ${
                  pathname === "/users" ? "text-ink-green" : "text-ink-muted"
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span className="text-[10px] font-mono">Users</span>
              </Link>
            )}
          </nav>
        </div>

        {/* ─── Content ─────────────────────────────────────────────────── */}
        <main className="flex-1 p-6 md:p-8 pb-24 md:pb-8 overflow-y-auto bg-ink-surface">
          {children}
        </main>
      </div>
    </div>
  );
}
