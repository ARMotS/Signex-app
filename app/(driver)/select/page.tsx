"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect, useCallback } from "react";

/**
 * Driver sign-in: company → driver → PIN.
 *
 * The company step exists because this page runs before anyone is authenticated,
 * so it has no session to derive a scope from. Picking a company is what selects
 * the scope, and the driver dropdown is then populated from that one scope only —
 * it can never contain another operator's drivers.
 *
 * Driver names are not fetched until a company is chosen, and the delivery counts
 * the old version of this page displayed are gone entirely.
 */

interface Company {
  id: string;
  name: string;
}

interface Driver {
  id: string;
  name: string;
}

export default function DriverSelectPage() {
  const router = useRouter();

  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [companyId, setCompanyId] = useState("");

  const [drivers, setDrivers] = useState<Driver[] | null>(null);
  const [driverId, setDriverId] = useState("");
  const [loadingDrivers, setLoadingDrivers] = useState(false);

  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectedDriver = drivers?.find((d) => d.id === driverId) ?? null;

  // Clear any stale driver data so an old session doesn't linger.
  useEffect(() => {
    localStorage.removeItem("signex-driver");
  }, []);

  useEffect(() => {
    fetch("/api/auth/companies")
      .then((r) => (r.ok ? r.json() : { companies: [] }))
      .then((d) => setCompanies(d.companies || []))
      .catch(() => setCompanies([]));
  }, []);

  /**
   * Driver list is scoped to the chosen company and refetched whenever it
   * changes. Selecting a company is a user event, so the state resets live in the
   * change handler below — doing them here would be a synchronous setState inside
   * an effect, which cascades renders.
   */
  useEffect(() => {
    if (!companyId) return;

    let cancelled = false;

    fetch(`/api/auth/drivers?company=${encodeURIComponent(companyId)}`)
      .then((r) => (r.ok ? r.json() : { drivers: [] }))
      .then((d) => {
        if (!cancelled) setDrivers(d.drivers || []);
      })
      .catch(() => {
        if (!cancelled) setDrivers([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingDrivers(false);
      });

    // A fast company switch must not let a stale response overwrite the new list.
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const handleCompanyChange = (id: string) => {
    setCompanyId(id);
    setDrivers(null);
    setDriverId("");
    setPin("");
    setError("");
    // Set here rather than at the top of the effect above, so the spinner appears
    // on the user's action instead of via a synchronous setState in an effect.
    setLoadingDrivers(Boolean(id));
  };

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
          // Narrows the candidate set server-side; the PIN is still what
          // authenticates, and the session scope comes from the matched row.
          company: companyId,
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
  }, [pin, selectedDriver, companyId, router]);

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

  // Auto-submit once the 4th digit is entered. Deliberately keyed on the PIN
  // only, so re-renders from the in-flight request do not resubmit.
  useEffect(() => {
    if (pin.length === 4 && selectedDriver && !submitting) {
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

  // ── Company + driver selection ──────────────────────────────────────
  const selectClasses =
    "w-full px-4 py-3.5 bg-ink-card border border-ink-border rounded font-mono text-base text-ink-black focus:border-ink-green focus:outline-none transition-colors disabled:opacity-50 appearance-none";

  return (
    <div className="flex-1 flex flex-col justify-center px-4 py-6">
      <div className="mb-8 text-center">
        <h1 className="font-mono text-xl font-medium text-ink-black tracking-tight">
          Driver sign-in
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          Select your company, then your name
        </p>
      </div>

      <div className="max-w-md mx-auto w-full space-y-5">
        {/* Company */}
        <div>
          <label
            htmlFor="company"
            className="block text-xs font-mono uppercase tracking-wide text-ink-muted mb-2"
          >
            Company
          </label>
          <select
            id="company"
            value={companyId}
            onChange={(e) => handleCompanyChange(e.target.value)}
            disabled={companies === null}
            className={selectClasses}
          >
            <option value="">
              {companies === null
                ? "Loading…"
                : companies.length === 0
                  ? "No companies available"
                  : "Select your company"}
            </option>
            {(companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* Driver — only populated once a company is chosen */}
        <div>
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
            disabled={!companyId || loadingDrivers}
            className={selectClasses}
          >
            <option value="">
              {!companyId
                ? "Select a company first"
                : loadingDrivers
                  ? "Loading…"
                  : drivers && drivers.length === 0
                    ? "No drivers set up for this company"
                    : "Select your name"}
            </option>
            {(drivers ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <div className="px-4 py-2 bg-ink-red-dim rounded border border-ink-red/20">
            <span className="text-xs font-mono text-ink-red">{error}</span>
          </div>
        )}

        {companies !== null && companies.length === 0 && (
          <p className="text-xs font-mono text-ink-muted text-center">
            Ask your dispatcher to add drivers to your company.
          </p>
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
