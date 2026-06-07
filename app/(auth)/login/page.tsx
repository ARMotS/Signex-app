"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);

  // Login state
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Signup state
  const [name, setName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session")
      .then((r) => r.json())
      .then((data) => {
        if (data.session?.role === "admin" || data.session?.role === "super_admin") {
          const params = new URLSearchParams(window.location.search);
          if (params.get("action") === "signup") {
            setMode("signup");
          } else {
            router.replace("/dashboard");
            return;
          }
        }
        if (data.needsSetup) {
          setNeedsSetup(true);
          setMode("signup");
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "admin", email, password }),
      });
      const data = await res.json();

      if (res.ok) {
        router.replace("/dashboard");
      } else {
        setError(data.error || "Login failed");
      }
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (signupPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (signupPassword.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email: signupEmail,
          password: signupPassword,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        if (data.firstAdmin) {
          router.replace("/dashboard");
        } else {
          setMode("login");
          setEmail(signupEmail);
          setError("");
        }
      } else {
        setError(data.error || "Signup failed");
      }
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-ink-surface">
        <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col items-center justify-center bg-ink-surface px-6">
      <div className="w-full max-w-sm animate-fade-in">
        {/* Logo */}
        <Link
          href="/"
          className="flex items-center gap-2 mb-10 justify-center hover:opacity-80 transition-opacity"
        >
          <div className="w-10 h-10 bg-ink-black rounded flex items-center justify-center">
            <svg
              width="22"
              height="22"
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
          <span className="font-mono text-xl font-medium tracking-tight text-ink-black">
            SIGNEX
          </span>
        </Link>

        {/* Card */}
        <div className="bg-ink-card border border-ink-border rounded p-8">
          {needsSetup && mode === "signup" && (
            <div className="flex items-center gap-2 px-3 py-2 mb-6 bg-ink-green-dim rounded border border-ink-green/20">
              <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
              <span className="text-xs font-mono text-ink-green">
                First time? Create your admin account
              </span>
            </div>
          )}

          <h1 className="font-mono text-lg font-medium text-ink-black mb-1">
            {mode === "login" ? "Admin Login" : "Create Admin Account"}
          </h1>
          <p className="text-sm text-ink-muted mb-6">
            {mode === "login"
              ? "Sign in to access the dispatcher dashboard."
              : "Set up your admin account to manage Signex."}
          </p>

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-ink-red-dim rounded border border-ink-red/20 animate-fade-in">
              <span className="text-xs font-mono text-ink-red">{error}</span>
            </div>
          )}

          {mode === "login" ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                  placeholder="admin@signex.app"
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                  placeholder="••••••"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full px-4 py-3 bg-ink-black text-white font-mono text-sm font-medium rounded hover:bg-ink-black/90 active:scale-[0.98] transition-all disabled:opacity-50 touch-target"
              >
                {submitting ? "Signing in…" : "Sign In"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSignup} className="space-y-4">
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
                  Full Name
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                  placeholder="Your name"
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
                  Email
                </label>
                <input
                  type="email"
                  value={signupEmail}
                  onChange={(e) => setSignupEmail(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                  placeholder="admin@signex.app"
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  value={signupPassword}
                  onChange={(e) => setSignupPassword(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                  placeholder="Min 6 characters"
                />
              </div>
              <div>
                <label className="block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5">
                  Confirm Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors"
                  placeholder="••••••"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="w-full px-4 py-3 bg-ink-green text-white font-mono text-sm font-medium rounded hover:bg-ink-green-hover active:scale-[0.98] transition-all disabled:opacity-50 touch-target"
              >
                {submitting ? "Creating account…" : "Create Account"}
              </button>
            </form>
          )}

          {/* Toggle mode */}
          {!needsSetup && (
            <div className="mt-5 pt-4 border-t border-ink-border text-center">
              <button
                onClick={() => {
                  setMode(mode === "login" ? "signup" : "login");
                  setError("");
                }}
                className="text-xs font-mono text-ink-muted hover:text-ink-green transition-colors"
              >
                {mode === "login"
                  ? "Need an account? Sign up"
                  : "Already have an account? Sign in"}
              </button>
            </div>
          )}
        </div>

        {/* Back link */}
        <div className="mt-6 text-center">
          <Link
            href="/"
            className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
          >
            ← Back to home
          </Link>
        </div>
      </div>
    </div>
  );
}
