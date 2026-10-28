"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import ScopeSwitcher, { ScopeBanner } from "@/components/admin/ScopeSwitcher";
import LogoMark from "@/components/LogoMark";

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
    label: "Courier",
    href: "/courier",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 18V6a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h1" />
        <path d="M14 9h4l3 3.5V17a1 1 0 0 1-1 1h-1" />
        <path d="M9 18h6" />
        <circle cx="6.5" cy="18" r="2" />
        <circle cx="17.5" cy="18" r="2" />
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
    label: "Collections",
    href: "/collections",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7h18l-1.5 12a2 2 0 0 1-2 1.8H6.5a2 2 0 0 1-2-1.8Z" />
        <path d="M8 7V5a4 4 0 0 1 8 0v2" />
      </svg>
    ),
  },
  {
    label: "Credits",
    href: "/credits",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6" />
        <path d="M9 15h6" />
        <path d="m11 12-2 3 2 3" />
      </svg>
    ),
  },
  {
    label: "Exceptions",
    href: "/exceptions",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
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
    // SUPER_ADMIN only — filtered out for everyone else in the layout.
    label: "Users",
    href: "/users",
    superAdminOnly: true,
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
    // SUPER_ADMIN only: companies, their branches and company admins.
    label: "Companies",
    href: "/companies",
    superAdminOnly: true,
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 21h18" />
        <path d="M5 21V7l7-4 7 4v14" />
        <path d="M9 21v-6h6v6" />
        <path d="M9 10h.01M15 10h.01" />
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
  const visibleNavItems = navItems.filter((item) => !item.superAdminOnly || role === "super_admin");

  useEffect(() => {
    const checkSession = () => {
      fetch("/api/auth/session")
        .then((r) => r.json())
        .then((data) => {
          if (data.kicked || !data.session) {
            // Kicked: signed out from another device (or a password reset) —
            // the login screen says so, rather than silently showing a form.
            router.replace(data.kicked ? "/login?signedOut=1" : "/login");
            return;
          }
          if (
            data.session.role === "admin" ||
            data.session.role === "super_admin" ||
            data.session.role === "company_admin"
          ) {
            setSession({ name: data.session.name, email: data.session.email });
            setRole(data.session.role);
          }
        })
        .catch(() => {});
    };

    // Not while hidden: a background tab learns nothing it needs, and every API
    // call is refused on a revoked session anyway. Shown again → checked at once.
    const checkIfVisible = () => {
      if (document.visibilityState === "visible") checkSession();
    };
    checkSession();
    const interval = setInterval(checkIfVisible, 60_000);
    document.addEventListener("visibilitychange", checkIfVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", checkIfVisible);
    };
  }, [router]);

  // The Courier badge: sheets that need the office. Polled gently, and not
  // at all while the tab is hidden; the dashboard carries the detail.
  const [courierAttention, setCourierAttention] = useState(0);
  useEffect(() => {
    if (!role) return;
    const look = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/courier/attention")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => typeof d?.attention === "number" && setCourierAttention(d.attention))
        .catch(() => {});
    };
    look();
    const interval = setInterval(look, 60_000);
    document.addEventListener("visibilitychange", look);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", look);
    };
  }, [role, pathname]);
  const badgeFor = (href: string) => (href === "/courier" ? courierAttention : 0);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  return (
    <div className="flex min-h-dvh">
      {/* ─── Sidebar ─────────────────────────────────────────────────── */}
      <aside className="hidden md:flex w-56 flex-col bg-sidebar-bg border-r border-white/5 shrink-0 fixed top-0 left-0 h-dvh z-40">
        {/* Logo — deliberately NOT a link. Inside the app the way out is Log out,
            which ends the session; a logo leading to the public home page would
            leave a signed-in session behind it. */}
        <div className="flex items-center gap-2 px-5 py-5 border-b border-white/5 shrink-0">
          <LogoMark size={28} />
          <span className="font-mono text-sm font-medium tracking-tight text-sidebar-text-active">
            SIGNEX
          </span>
          <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/5 text-sidebar-text">
            ADMIN
          </span>
        </div>

        {/* Nav + scope switcher scroll together; the logo and the account
            footer stay pinned, so Log out is reachable on short windows
            (e.g. with the browser's bookmarks bar showing). */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col">
        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {visibleNavItems.map((item) => {
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
                {badgeFor(item.href) > 0 ? (
                  <span
                    className="ml-auto min-w-5 h-5 px-1.5 rounded-full bg-ink-amber text-[11px] leading-5 text-center text-ink-black"
                    aria-label={`${badgeFor(item.href)} need attention`}
                  >
                    {badgeFor(item.href)}
                  </span>
                ) : (
                  isActive && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-ink-green" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Scope switcher — SUPER_ADMIN only, renders nothing otherwise */}
        <ScopeSwitcher role={role} />
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-white/5 shrink-0">
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
              title="Log out"
              aria-label="Log out"
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
          {/* Not a link — see the sidebar logo. */}
          <div className="flex items-center gap-2">
            <LogoMark size={28} />
            <span className="font-mono text-sm font-medium text-ink-black">
              SIGNEX
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 h-8 px-2.5 rounded text-xs font-medium hover:bg-ink-surface transition-colors text-ink-muted hover:text-ink-red"
              title="Log out"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Log out
            </button>
          </div>
        </header>

        {/* Mobile bottom nav */}
        <div className="md:hidden fixed bottom-0 left-0 right-0 bg-ink-card border-t border-ink-border z-50 safe-bottom">
          {/* Eight or nine destinations cannot share a phone's width without
              clipping their labels, so the bar scrolls sideways instead. */}
          <nav className="flex items-center gap-1 px-1 py-2 overflow-x-auto [scrollbar-width:none]">
            {visibleNavItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex flex-col items-center gap-1 px-2.5 py-1.5 shrink-0 rounded transition-colors touch-target ${
                    isActive ? "text-ink-green" : "text-ink-muted"
                  }`}
                >
                  <span className="relative">
                    {item.icon}
                    {badgeFor(item.href) > 0 && (
                      <span className="absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-ink-amber text-[10px] leading-4 text-center text-ink-black">
                        {badgeFor(item.href)}
                      </span>
                    )}
                  </span>
                  <span className="text-[10px] font-mono whitespace-nowrap">{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Warns whenever a SUPER_ADMIN is viewing another ADMIN's scope */}
        <ScopeBanner role={role} />

        {/* ─── Content ─────────────────────────────────────────────────── */}
        {/* 16px gutter on a phone: 24px either side left too little room for
            the trip cards and invoice tables. */}
        <main className="flex-1 p-4 sm:p-6 md:p-8 pb-24 md:pb-8 overflow-y-auto bg-ink-surface">
          {children}
        </main>
      </div>
    </div>
  );
}
