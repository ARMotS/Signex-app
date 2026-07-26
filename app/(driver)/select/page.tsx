"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect, useCallback } from "react";

/**
 * Driver sign-in: name + PIN.
 *
 * This page used to fetch and display every driver in the installation from a
 * public, unauthenticated endpoint — which meant anyone could enumerate every
 * ADMIN's driver names and live delivery counts. That endpoint is gone. The
 * driver now types their name, and the server resolves which ADMIN's scope they
 * belong to from the name+PIN pair. Nothing about who exists is revealed before
 * a successful sign-in.
 */
export default function DriverSelectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [nameConfirmed, setNameConfirmed] = useState(false);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Clear old driver data so stale sessions don't persist
    localStorage.removeItem("signex-driver");
  }, []);

  const handlePinSubmit = useCallback(async () => {
    if (pin.length !== 4 || !name.trim()) return;
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "driver",
          name: name.trim(),
          pin,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        // The server is the source of truth for identity and scope; this is
        // only a display convenience for the run screen.
        localStorage.setItem(
          "signex-driver",
          JSON.stringify({
            id: data.account.id,
            name: data.account.name,
          })
        );
        router.push("/run");
      } else {
        setError(data.error || "Login failed");
        setPin("");
      }
    } catch {
      setError("Network error");
      setPin("");
    } finally {
      setSubmitting(false);
    }
  }, [pin, name, router]);

  const handlePinInput = (digit: string) => {
    if (pin.length < 4) {
      setPin(pin + digit);
      setError("");
    }
  };

  const handleBackspace = () => {
    setPin(pin.slice(0, -1));
    setError("");
  };

  // Auto-submit when PIN reaches 4 digits
  useEffect(() => {
    if (pin.length === 4 && nameConfirmed && !submitting) {
      handlePinSubmit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, nameConfirmed]);

  // ── PIN entry screen ────────────────────────────────────────────────
  if (nameConfirmed) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 animate-fade-in">
        <div className="w-16 h-16 rounded-full bg-ink-surface flex items-center justify-center mb-4">
          <span className="text-xl font-mono font-medium text-ink-muted">
            {name
              .trim()
              .split(/\s+/)
              .map((n) => n[0])
              .join("")
              .toUpperCase()
              .slice(0, 2)}
          </span>
        </div>
        <p className="font-mono text-lg font-medium text-ink-black mb-1">
          {name.trim()}
        </p>
        <p className="text-sm text-ink-muted mb-8">Enter your 4-digit PIN</p>

        {error && (
          <div className="flex items-center gap-2 px-4 py-2 mb-4 bg-ink-red-dim rounded border border-ink-red/20 animate-fade-in">
            <span className="text-xs font-mono text-ink-red">{error}</span>
          </div>
        )}

        {/* PIN dots */}
        <div className="flex gap-4 mb-8">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full transition-all ${
                i < pin.length ? "bg-ink-green scale-110" : "bg-ink-border"
              }`}
            />
          ))}
        </div>

        {/* Number pad */}
        <div className="grid grid-cols-3 gap-3 max-w-[240px] w-full">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map(
            (key) => {
              if (key === "") return <div key="empty" />;
              if (key === "⌫") {
                return (
                  <button
                    key="back"
                    onClick={handleBackspace}
                    className="h-14 rounded-lg bg-ink-surface flex items-center justify-center text-ink-muted hover:bg-ink-border active:scale-95 transition-all touch-target"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
                      <line x1="18" y1="9" x2="12" y2="15" />
                      <line x1="12" y1="9" x2="18" y2="15" />
                    </svg>
                  </button>
                );
              }
              return (
                <button
                  key={key}
                  onClick={() => handlePinInput(key)}
                  disabled={submitting}
                  className="h-14 rounded-lg bg-ink-card border border-ink-border flex items-center justify-center font-mono text-xl font-medium text-ink-black hover:bg-ink-surface active:scale-95 transition-all touch-target disabled:opacity-50"
                >
                  {key}
                </button>
              );
            }
          )}
        </div>

        {submitting && (
          <div className="mt-6 flex items-center gap-2 text-sm font-mono text-ink-muted">
            <div className="w-4 h-4 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
            Signing in…
          </div>
        )}

        <button
          onClick={() => {
            setNameConfirmed(false);
            setPin("");
            setError("");
          }}
          className="mt-8 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
        >
          ← Change name
        </button>
      </div>
    );
  }

  // ── Name entry screen ───────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col justify-center px-4 py-6">
      <div className="mb-8 text-center">
        <h1 className="font-mono text-xl font-medium text-ink-black tracking-tight">
          Driver sign-in
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          Enter your name exactly as your dispatcher set it up
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim().length > 0) {
            setError("");
            setNameConfirmed(true);
          }
        }}
        className="max-w-md mx-auto w-full"
      >
        <label
          htmlFor="driver-name"
          className="block text-xs font-mono uppercase tracking-wide text-ink-muted mb-2"
        >
          Your name
        </label>
        <input
          id="driver-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          autoCapitalize="words"
          autoFocus
          placeholder="e.g. John Mokoena"
          className="w-full px-4 py-3.5 bg-ink-card border border-ink-border rounded font-mono text-base text-ink-black placeholder:text-ink-muted-light focus:border-ink-green focus:outline-none transition-colors"
        />

        <button
          type="submit"
          disabled={name.trim().length === 0}
          className="w-full mt-4 px-4 py-3.5 rounded bg-ink-green text-white font-mono text-sm font-medium hover:bg-ink-green/90 active:scale-[0.99] transition-all touch-target disabled:opacity-40 disabled:active:scale-100"
        >
          Continue
        </button>
      </form>

      <div className="mt-auto pt-8 text-center">
        <p className="text-xs font-mono text-ink-muted">
          Trouble signing in? Ask your dispatcher to check your name and PIN.
        </p>
      </div>
    </div>
  );
}
