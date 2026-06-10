"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";

interface Driver {
  id: string;
  name: string;
  active: boolean;
  stopCount: number;
  signedCount: number;
}

export default function DriverSelectPage() {
  const router = useRouter();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDriver, setSelectedDriver] = useState<Driver | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // Clear old driver data so stale sessions don't persist
    localStorage.removeItem("signex-driver");

    fetch("/api/auth/drivers")
      .then((r) => r.json())
      .then((data) => {
        setDrivers((data.drivers || []).filter((d: Driver) => d.active));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handlePinSubmit = async () => {
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
        }),
      });
      const data = await res.json();

      if (res.ok) {
        localStorage.setItem(
          "signex-driver",
          JSON.stringify({
            id: selectedDriver.id,
            name: selectedDriver.name,
          })
        );
        router.push("/run");
      } else {
        setError(data.error || "Login failed");
        setPin("");
      }
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const handlePinInput = (digit: string) => {
    if (pin.length < 4) {
      const newPin = pin + digit;
      setPin(newPin);
      setError("");
      // Auto-submit on 4 digits
      if (newPin.length === 4) {
        setTimeout(() => {
          setPin(newPin);
          // trigger submit after state update
        }, 50);
      }
    }
  };

  const handleBackspace = () => {
    setPin(pin.slice(0, -1));
    setError("");
  };

  // Auto-submit when PIN reaches 4 digits
  useEffect(() => {
    if (pin.length === 4 && selectedDriver && !submitting) {
      handlePinSubmit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
      </div>
    );
  }

  // PIN entry screen
  if (selectedDriver) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-4 py-6 animate-fade-in">
        <div className="w-16 h-16 rounded-full bg-ink-surface flex items-center justify-center mb-4">
          <span className="text-xl font-mono font-medium text-ink-muted">
            {selectedDriver.name.split(" ").map((n) => n[0]).join("")}
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

        {/* PIN dots */}
        <div className="flex gap-4 mb-8">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full transition-all ${
                i < pin.length
                  ? "bg-ink-green scale-110"
                  : "bg-ink-border"
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
            setSelectedDriver(null);
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

  // Driver selection screen
  return (
    <div className="flex-1 flex flex-col px-4 py-6">
      <div className="mb-8 text-center">
        <h1 className="font-mono text-xl font-medium text-ink-black tracking-tight">
          Select your name
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          Tap your name to start your delivery run
        </p>
      </div>

      {drivers.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
          <div className="text-4xl mb-4">👤</div>
          <p className="font-mono text-sm font-medium text-ink-black mb-2">
            No drivers available
          </p>
          <p className="text-xs text-ink-muted max-w-sm">
            Ask your dispatcher to add you to the system from the admin dashboard.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 max-w-md mx-auto w-full stagger-children">
          {drivers.map((driver) => {
            const hasStops = driver.stopCount > 0;
            const allSigned = hasStops && driver.signedCount === driver.stopCount;

            return (
              <button
                key={driver.id}
                onClick={() => setSelectedDriver(driver)}
                className="flex items-center gap-4 w-full p-5 bg-ink-card border border-ink-border rounded text-left hover:border-ink-green hover:bg-ink-green-dim active:scale-[0.98] transition-all touch-target"
              >
                <div className="w-12 h-12 rounded bg-ink-surface flex items-center justify-center shrink-0">
                  <span className="text-lg font-mono font-medium text-ink-muted">
                    {driver.name.split(" ").map((n) => n[0]).join("")}
                  </span>
                </div>
                <div className="flex-1">
                  <p className="font-mono text-base font-medium text-ink-black">
                    {driver.name}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    {hasStops && (
                      <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${
                        allSigned
                          ? "bg-ink-green-dim text-ink-green"
                          : "bg-ink-amber-dim text-ink-amber"
                      }`}>
                        {driver.signedCount}/{driver.stopCount} stops
                      </span>
                    )}
                    {!hasStops && (
                      <span className="text-xs text-ink-muted">
                        No deliveries
                      </span>
                    )}
                  </div>
                </div>
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-ink-muted-light"
                >
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-auto pt-8 text-center">
        <p className="text-xs font-mono text-ink-muted">
          Don&apos;t see your name? Ask your dispatcher to add you.
        </p>
      </div>
    </div>
  );
}
