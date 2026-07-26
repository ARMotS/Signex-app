"use client";

import { useRouter, useParams } from "next/navigation";
import { useState, useEffect, useCallback } from "react";

/**
 * Per-operator driver sign-in: /select/<slug>
 *
 * The slug in the URL selects the scope, because this page runs before anyone is
 * authenticated and so has no session to derive one from. Each ADMIN shares their
 * own link with their own drivers; the dropdown can only ever contain that
 * operator's drivers.
 *
 * There is deliberately no public list of operators — someone without a link sees
 * nothing. An unknown slug and a deactivated operator are indistinguishable.
 */

interface Driver {
  id: string;
  name: string;
}

export default function DriverSelectForCompanyPage() {
  const router = useRouter();
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? "";

  const [companyName, setCompanyName] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<Driver[] | null>(null);
  const [driverId, setDriverId] = useState("");

  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectedDriver = drivers?.find((d) => d.id === driverId) ?? null;

  useEffect(() => {
    localStorage.removeItem("signex-driver");
  }, []);

  useEffect(() => {
    if (!slug) return;
    let cancelled = false;

    fetch(`/api/auth/drivers?company=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() : { drivers: [], companyName: null }))
      .then((d) => {
        if (cancelled) return;
        setDrivers(d.drivers || []);
        setCompanyName(d.companyName ?? null);
      })
      .catch(() => {
        if (!cancelled) setDrivers([]);
      });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  const handlePinSubmit = useCallback(async () => {
    if (pin.length !== 4 || !selectedDriver) return;
    setError("");
    setSubmitting(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "driver",
          name: selectedDriver.name,
          pin,
          // Narrows the candidate set server-side. The PIN is still what
          // authenticates, and the session scope comes from the matched row.
          company: slug,
        }),
      });
      const data = await res.json();

      if (res.ok) {
        localStorage.setItem(
          "signex-driver",
          JSON.stringify({ id: data.account.id, name: data.account.name })
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
  }, [pin, selectedDriver, slug, router]);

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

  useEffect(() => {
    if (pin.length === 4 && selectedDriver && !submitting) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      handlePinSubmit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  // ── PIN entry ───────────────────────────────────────────────────────
  if (selectedDriver) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 animate-fade-in">
        <div className="w-16 h-16 rounded-full bg-ink-surface flex items-center justify-center mb-4">
          <span className="text-xl font-mono font-medium text-ink-muted">
            {selectedDriver.name
              .split(/\s+/)
              .map((n) => n[0])
              .join("")
              .toUpperCase()
              .slice(0, 2)}
          </span>
        </div>
        <p className="font-mono text-lg font-medium text-ink-black mb-1">
          {selectedDriver.name}
        </p>
        <p className="text-sm text-ink-muted mb-8">Enter your 4-digit PIN</p>

        {error && (
          <div className="flex items-center gap-2 px-4 py-2 mb-4 bg-ink-red-dim rounded border border-ink-red/20 animate-fade-in">
            <span className="text-xs font-mono text-ink-red">{error}</span>
          </div>
        )}

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
            setDriverId("");
            setPin("");
            setError("");
          }}
          className="mt-8 text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
        >
          ← Choose a different driver
        </button>
      </div>
    );
  }

  // ── Loading ─────────────────────────────────────────────────────────
  if (drivers === null) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
      </div>
    );
  }

  // ── Valid link, but this operator has no drivers set up yet ─────────
  //
  // Distinct from an unknown link: the slug resolved and we know the company
  // name, so telling the driver their link is broken would send them chasing the
  // wrong problem. The fix is for their dispatcher to add them.
  if (drivers.length === 0 && companyName) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10">
        <div className="text-4xl mb-4">👤</div>
        <p className="font-mono text-sm font-medium text-ink-black mb-1">
          {companyName}
        </p>
        <p className="font-mono text-sm text-ink-black mb-2">
          No drivers set up yet
        </p>
        <p className="text-xs text-ink-muted max-w-sm">
          Your link is correct, but no drivers have been added to this company
          yet. Ask your dispatcher to add you from the Drivers page.
        </p>
      </div>
    );
  }

  // ── Unknown link, or operator deactivated (indistinguishable) ───────
  if (drivers.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10">
        <div className="text-4xl mb-4">🔗</div>
        <p className="font-mono text-sm font-medium text-ink-black mb-2">
          This sign-in link isn&apos;t available
        </p>
        <p className="text-xs text-ink-muted max-w-sm">
          The link may be incorrect or out of date. Ask your dispatcher for your
          company&apos;s sign-in link.
        </p>
      </div>
    );
  }

  // ── Driver selection ────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col justify-center px-4 py-6">
      <div className="mb-8 text-center">
        <h1 className="font-mono text-xl font-medium text-ink-black tracking-tight">
          Driver sign-in
        </h1>
        {companyName && (
          <p className="font-mono text-sm text-ink-green mt-1">{companyName}</p>
        )}
        <p className="text-sm text-ink-muted mt-1">Select your name to continue</p>
      </div>

      <div className="max-w-md mx-auto w-full">
        <label
          htmlFor="driver"
          className="block text-xs font-mono uppercase tracking-wide text-ink-muted mb-2"
        >
          Your name
        </label>
        <select
          id="driver"
          value={driverId}
          onChange={(e) => {
            setDriverId(e.target.value);
            setPin("");
            setError("");
          }}
          className="w-full px-4 py-3.5 bg-ink-card border border-ink-border rounded font-mono text-base text-ink-black focus:border-ink-green focus:outline-none transition-colors appearance-none"
        >
          <option value="">Select your name</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>

        {error && (
          <div className="mt-4 px-4 py-2 bg-ink-red-dim rounded border border-ink-red/20">
            <span className="text-xs font-mono text-ink-red">{error}</span>
          </div>
        )}
      </div>

      <div className="mt-auto pt-8 text-center">
        <p className="text-xs font-mono text-ink-muted">
          Don&apos;t see your name? Ask your dispatcher to add you.
        </p>
      </div>
    </div>
  );
}
