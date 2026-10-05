"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import PasswordInput from "@/components/PasswordInput";
import SigningDemo from "@/components/SigningDemo";
import {
  homePathForRole,
  validatePassword,
  validateUsername,
  PASSWORD_HINT,
  USERNAME_HINT,
} from "@/lib/credentials";

/**
 * The one way in, shown at both / and /login: a hero that shows what Signex
 * does, beside the one sign-in for every role. Username + password; the server
 * decides the role and scope from the account, and says where that role lands.
 *
 * The only other mode is first-run setup, shown when the installation has no
 * accounts at all.
 *
 * On a phone the form comes first and the demo after it — a driver opening the
 * app at the start of a shift should not have to scroll to log in.
 */

const INPUT_CLASS =
  "w-full px-4 py-3 bg-ink-surface border border-ink-border rounded-md text-base sm:text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-black focus:ring-2 focus:ring-ink-black/10 transition-colors";
const LABEL_CLASS = "block text-sm font-medium text-ink-black mb-1.5";

/**
 * The driver screens read who is signed in from here (see app/(driver)/run).
 * Written on a driver sign-in, cleared on any other so an office account on a
 * shared device never inherits a driver's run.
 */
function rememberDriver(role: string, account?: { id: string; name: string }) {
  try {
    if (role === "driver" && account) {
      localStorage.setItem("signex-driver", JSON.stringify({ id: account.id, name: account.name }));
    } else {
      localStorage.removeItem("signex-driver");
    }
  } catch {
    // Storage unavailable (private mode) — the driver pages report it.
  }
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="w-9 h-9 bg-ink-black rounded-lg flex items-center justify-center">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00C07F" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      </div>
      <span className="text-lg font-semibold tracking-tight text-ink-black">Signex</span>
    </div>
  );
}

export default function SignInScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [checkingSession, setCheckingSession] = useState(true);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // First-run setup
  const [name, setName] = useState("");
  const [setupEmail, setSetupEmail] = useState("");
  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        // Already signed in — straight on to their own screen.
        if (data.session?.role) {
          rememberDriver(data.session.role, data.session);
          router.replace(homePathForRole(data.session.role));
          return;
        }
        if (data.needsSetup) setMode("setup");
        setCheckingSession(false);
      })
      .catch(() => setCheckingSession(false));
  }, [router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        rememberDriver(data.role, data.account);
        router.replace(data.redirectTo || homePathForRole(data.role));
        return;
      }
      setError(data.error || "Incorrect username or password");
      setPassword("");
    } catch {
      setError("Can't reach Signex. Check your connection and try again.");
    }
    setSubmitting(false);
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const invalid = validateUsername(setupUsername) ?? validatePassword(setupPassword);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (setupPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email: setupEmail,
          username: setupUsername,
          password: setupPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        rememberDriver("super_admin");
        router.replace(homePathForRole("super_admin"));
        return;
      }
      setError(data.error || "Setup failed");
    } catch {
      setError("Can't reach Signex. Check your connection and try again.");
    }
    setSubmitting(false);
  };

  const form =
    mode === "login" ? (
      <form onSubmit={handleLogin} className="space-y-4">
        <div>
          <label htmlFor="username" className={LABEL_CLASS}>
            Username
          </label>
          <input
            id="username"
            name="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={INPUT_CLASS}
            placeholder="Your Signex username"
          />
        </div>
        <div>
          <label htmlFor="password" className={LABEL_CLASS}>
            Password
          </label>
          <PasswordInput
            id="password"
            name="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            className={INPUT_CLASS}
            placeholder="Enter your password"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full px-4 py-3 bg-ink-black text-white text-sm font-semibold rounded-md hover:bg-ink-black/85 active:scale-[0.99] transition-all disabled:opacity-50 touch-target focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ink-green"
        >
          {submitting ? "Logging in…" : "Log in"}
        </button>
        <p className="text-sm text-ink-muted">
          Forgotten your login? Ask your office to reset it.
        </p>
      </form>
    ) : (
      <form onSubmit={handleSetup} className="space-y-4">
        <div>
          <label htmlFor="setup-name" className={LABEL_CLASS}>
            Full name
          </label>
          <input
            id="setup-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoComplete="name"
            className={INPUT_CLASS}
            placeholder="Your full name"
          />
        </div>
        <div>
          <label htmlFor="setup-email" className={LABEL_CLASS}>
            Email
          </label>
          <input
            id="setup-email"
            type="email"
            value={setupEmail}
            onChange={(e) => setSetupEmail(e.target.value)}
            required
            autoComplete="email"
            className={INPUT_CLASS}
            placeholder="Your work email"
          />
        </div>
        <div>
          <label htmlFor="setup-username" className={LABEL_CLASS}>
            Username
          </label>
          <input
            id="setup-username"
            type="text"
            value={setupUsername}
            onChange={(e) => setSetupUsername(e.target.value)}
            required
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className={INPUT_CLASS}
            placeholder="Choose a username"
          />
          <p className="text-xs text-ink-muted mt-1.5">{USERNAME_HINT}</p>
        </div>
        <div>
          <label htmlFor="setup-password" className={LABEL_CLASS}>
            Password
          </label>
          <PasswordInput
            id="setup-password"
            value={setupPassword}
            onChange={(e) => setSetupPassword(e.target.value)}
            required
            autoComplete="new-password"
            className={INPUT_CLASS}
            placeholder="Create a password"
          />
          <p className="text-xs text-ink-muted mt-1.5">{PASSWORD_HINT}</p>
        </div>
        <div>
          <label htmlFor="setup-confirm" className={LABEL_CLASS}>
            Confirm password
          </label>
          <PasswordInput
            id="setup-confirm"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            autoComplete="new-password"
            className={INPUT_CLASS}
            placeholder="Enter it again"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="w-full px-4 py-3 bg-ink-black text-white text-sm font-semibold rounded-md hover:bg-ink-black/85 active:scale-[0.99] transition-all disabled:opacity-50 touch-target focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-ink-green"
        >
          {submitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    );

  return (
    <div className="min-h-dvh bg-ink-surface lg:grid lg:grid-cols-[minmax(0,1fr)_480px]">
      {/* ─── Hero: what Signex is for ─────────────────────────────────── */}
      <section className="px-4 pt-6 sm:px-10 lg:px-16 lg:pt-12 lg:pb-12 flex flex-col">
        <Brand />
        <div className="mt-8 lg:mt-auto max-w-xl">
          <h1 className="text-[2rem] leading-[1.1] sm:text-5xl lg:text-[3.5rem] font-semibold tracking-[-0.03em] text-ink-black text-balance">
            Every delivery, signed at the door.
          </h1>
          <p className="mt-4 text-base sm:text-lg leading-relaxed text-ink-muted max-w-md">
            Drivers capture the customer&apos;s signature on the invoice itself, and the
            office sees it the moment it&apos;s done.
          </p>
        </div>
        {/* Desktop: the demo sits under the headline. On a phone it follows the form. */}
        <SigningDemo className="hidden lg:block mt-12 mb-auto w-full max-w-md -rotate-2 origin-bottom-left" />
      </section>

      {/* ─── Sign-in ──────────────────────────────────────────────────── */}
      <section className="px-4 py-8 sm:px-10 lg:bg-white lg:border-l lg:border-ink-border lg:flex lg:flex-col lg:justify-center lg:px-12">
        <div className="w-full max-w-sm lg:mx-auto">
          {mode === "setup" && (
            <p className="text-sm text-ink-black bg-ink-green-dim border border-ink-green/25 rounded-md px-3 py-2 mb-6">
              First time here? Create the account that runs Signex.
            </p>
          )}
          <h2 className="text-xl font-semibold text-ink-black mb-6">
            {mode === "login" ? "Log in" : "Set up Signex"}
          </h2>

          {error && (
            <div
              role="alert"
              className="px-3 py-2.5 mb-4 bg-ink-red-dim rounded-md border border-ink-red/20 animate-fade-in"
            >
              <span className="text-sm text-ink-red">{error}</span>
            </div>
          )}

          {checkingSession ? (
            <div className="py-16 flex justify-center" aria-label="Checking your session">
              <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
            </div>
          ) : (
            form
          )}
        </div>
      </section>

      {/* Phone and tablet: the demo after the form. */}
      <div className="lg:hidden px-4 pb-12 sm:px-10">
        <SigningDemo className="max-w-sm mx-auto sm:mx-0" />
      </div>
    </div>
  );
}
