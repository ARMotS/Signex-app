"use client";

import Link from "next/link";
import { useEffect, useState, useCallback } from "react";

interface DriverInfo {
  id: string;
  name: string;
  stops: number;
}

interface TripStop {
  id: string;
  stopNumber: number;
  invoiceNumber: string;
  customerName: string;
  address: string;
  nop: number;
  invoiceFile?: string;
  status: "PENDING" | "IN_PROGRESS" | "SIGNED";
  signedAt?: string;
}

interface DriverTripSheet {
  id: string;
  status: "ACTIVE" | "QUEUED";
  sourceFilename: string;
  regNo: string;
  uploadedAt: string;
  stops: TripStop[];
}

export default function RunPage() {
  const [driver, setDriver] = useState<DriverInfo | null>(null);
  const [stops, setStops] = useState<TripStop[]>([]);
  const [tripSheets, setTripSheets] = useState<DriverTripSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStops = useCallback(async (driverId: string) => {
    try {
      const res = await fetch(`/api/trip-sheet/stops?driverId=${driverId}`);
      const data = await res.json();
      if (res.ok) {
        setStops(data.stops || []);
        setTripSheets(data.tripSheets || []);
      } else {
        setError(data.error || "Failed to load stops");
      }
    } catch {
      setError("Failed to connect to server");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("signex-driver");
    if (stored) {
      try {
        const driverData = JSON.parse(stored);
        setDriver(driverData);
        fetchStops(driverData.id);
      } catch {
        // Corrupt localStorage entry — clear it
        localStorage.removeItem("signex-driver");
        setLoading(false);
      }
    } else {
      setLoading(false);
    }
  }, [fetchStops]);

  const updateStopStatus = async (stopId: string, status: TripStop["status"]) => {
    try {
      const res = await fetch("/api/trip-sheet/stops", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopId, status }),
      });
      if (res.ok && driver) {
        // Refresh stops
        fetchStops(driver.id);
      }
    } catch {
      // ignore
    }
  };

  const signed = stops.filter((s) => s.status === "SIGNED").length;
  const total = stops.length;
  const pct = total > 0 ? Math.round((signed / total) * 100) : 0;

  return (
    <div className="flex-1 flex flex-col px-4 py-4">
      {/* Driver info + progress */}
      <div className="bg-ink-card border border-ink-border rounded p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="font-mono text-sm font-medium text-ink-black">
              {driver?.name ?? "Driver"}
            </p>
          </div>
          <span className="font-mono text-sm font-medium text-ink-green">
            {signed}/{total}
          </span>
        </div>
        <div className="h-2.5 bg-ink-surface rounded-full overflow-hidden">
          <div
            className="h-full bg-ink-green rounded-full transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-xs text-ink-muted mt-2 font-mono">
          {total > 0 ? `${pct}% complete` : "No deliveries assigned"}
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="bg-ink-card border border-ink-border rounded p-12 text-center">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm font-mono text-ink-muted">Loading deliveries…</p>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-ink-red-dim border border-ink-red/20 rounded p-6 text-center">
          <p className="text-sm font-mono text-ink-red">{error}</p>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && stops.length === 0 && (
        <div className="bg-ink-card border-2 border-dashed border-ink-border rounded p-10 text-center flex-1 flex flex-col items-center justify-center">
          <div className="text-4xl mb-4">📦</div>
          <p className="font-mono text-sm font-medium text-ink-black mb-2">
            No deliveries assigned
          </p>
          <p className="text-xs text-ink-muted max-w-xs mb-1">
            {driver
              ? `Logged in as "${driver.name}"`
              : "No driver selected"}
          </p>
          <p className="text-xs text-ink-muted max-w-xs">
            Your admin hasn&apos;t uploaded a trip sheet for you yet, or it may be assigned to a different driver.
          </p>
          <Link
            href="/select"
            className="mt-4 px-4 py-2 text-xs font-mono bg-ink-green-dim text-ink-green rounded hover:bg-ink-green hover:text-white transition-all"
          >
            Switch Driver
          </Link>
        </div>
      )}

      {/* Stop list */}
      {!loading && stops.length > 0 && (
        <div className="space-y-2 stagger-children">
          {stops.map((stop) => (
            <div
              key={stop.id}
              className={`flex items-start gap-3 p-4 bg-ink-card border rounded transition-all touch-target ${
                stop.status === "IN_PROGRESS"
                  ? "border-ink-amber bg-ink-amber-dim"
                  : stop.status === "SIGNED"
                  ? "border-ink-border opacity-60"
                  : "border-ink-border hover:border-ink-muted-light"
              }`}
            >
              {/* Stop number */}
              <div
                className={`w-8 h-8 rounded flex items-center justify-center shrink-0 font-mono text-sm font-medium ${
                  stop.status === "SIGNED"
                    ? "bg-ink-green-dim text-ink-green"
                    : stop.status === "IN_PROGRESS"
                    ? "bg-ink-amber-dim text-ink-amber"
                    : "bg-ink-surface text-ink-muted"
                }`}
              >
                {stop.status === "SIGNED" ? "✓" : stop.stopNumber}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-mono text-sm font-medium text-ink-black truncate">
                    {stop.customerName}
                  </p>
                </div>
                <p className="text-xs text-ink-muted mt-0.5">
                    {stop.invoiceNumber}
                    {stop.nop > 0 && (
                      <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 bg-ink-surface rounded text-[10px] font-mono">
                        📦 {stop.nop} {stop.nop === 1 ? "parcel" : "parcels"}
                      </span>
                    )}
                  </p>

                {/* Action buttons for non-signed stops */}
                {stop.status !== "SIGNED" && (
                  <div className="flex items-center gap-2 mt-2">
                    {stop.status === "PENDING" && (
                      <button
                        onClick={() => updateStopStatus(stop.id, "IN_PROGRESS")}
                        className="px-3 py-1.5 text-xs font-mono bg-ink-amber-dim text-ink-amber rounded hover:bg-ink-amber hover:text-white transition-all"
                      >
                        Start Delivery
                      </button>
                    )}
                    {stop.status === "IN_PROGRESS" && (
                      <>
                        {stop.invoiceFile ? (
                          <Link
                            href={`/api/invoices/${encodeURIComponent(stop.invoiceFile)}`}
                            target="_blank"
                            className="px-3 py-1.5 text-xs font-mono bg-ink-green-dim text-ink-green rounded hover:bg-ink-green hover:text-white transition-all"
                          >
                            View Invoice
                          </Link>
                        ) : null}
                        <Link
                          href={`/sign/${stop.id}`}
                          className="px-3 py-1.5 text-xs font-mono bg-ink-green text-white rounded hover:bg-ink-green-hover transition-all inline-flex items-center gap-1.5"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                          </svg>
                          Get Signature
                        </Link>
                      </>
                    )}
                  </div>
                )}
              </div>

              <span
                className={
                  stop.status === "SIGNED"
                    ? "badge-signed"
                    : stop.status === "IN_PROGRESS"
                    ? "badge-progress"
                    : "badge-pending"
                }
              >
                {stop.status === "SIGNED"
                  ? "Signed"
                  : stop.status === "IN_PROGRESS"
                  ? "Current"
                  : "Pending"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Queued trip sheets */}
      {!loading && tripSheets.filter((t) => t.status === "QUEUED").length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-mono text-ink-muted uppercase tracking-wide px-1">
            Up Next
          </p>
          {tripSheets
            .filter((t) => t.status === "QUEUED")
            .map((sheet) => (
              <div
                key={sheet.id}
                className="flex items-center gap-3 p-3 bg-ink-card border border-ink-border rounded opacity-70"
              >
                <div className="w-8 h-8 rounded bg-ink-surface flex items-center justify-center shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-muted">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-sm text-ink-black truncate">
                    {sheet.sourceFilename}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {sheet.stops.length} stop{sheet.stops.length !== 1 ? "s" : ""} · Queued
                  </p>
                </div>
                <span className="px-2 py-0.5 text-[10px] font-mono font-medium rounded bg-ink-surface text-ink-muted border border-ink-border">
                  QUEUED
                </span>
              </div>
            ))}
        </div>
      )}

      {/* Change driver */}
      <div className="mt-auto pt-6 text-center">
        <Link
          href="/select"
          className="text-xs font-mono text-ink-muted hover:text-ink-black transition-colors"
        >
          ← Change driver
        </Link>
      </div>
    </div>
  );
}
