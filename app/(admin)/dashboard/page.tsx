"use client";

import { useState, useEffect } from "react";

interface TripStop {
  id: string;
  invoiceNumber: string;
  customerName: string;
  status: "PENDING" | "IN_PROGRESS" | "SIGNED";
  signedAt?: string;
}

interface TripSheet {
  driverName: string;
  stops: TripStop[];
}

interface InvoiceData {
  count: number;
  signedCount: number;
  unsignedCount: number;
}

export default function DashboardPage() {
  const [invoiceStats, setInvoiceStats] = useState<InvoiceData | null>(null);
  const [tripSheets, setTripSheets] = useState<TripSheet[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch both invoice stats and trip data
    Promise.all([
      fetch("/api/invoices").then((r) => r.json()),
      fetch("/api/trip-sheet").then((r) => r.json()).catch(() => ({ tripSheets: [] })),
    ])
      .then(([invData, tripData]) => {
        if (!invData.error) setInvoiceStats(invData);
        if (tripData.tripSheets) setTripSheets(tripData.tripSheets);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Compute real stats
  const totalInvoices = invoiceStats?.count ?? 0;
  const signedCount = invoiceStats?.signedCount ?? 0;
  const unsignedCount = invoiceStats?.unsignedCount ?? 0;
  const activeDrivers = tripSheets.length;

  const signedPct = totalInvoices > 0 ? Math.round((signedCount / totalInvoices) * 100) : 0;

  const stats = [
    { label: "Total Invoices", value: String(totalInvoices), change: "In folder", color: "ink-black" },
    { label: "Signed", value: String(signedCount), change: `${signedPct}%`, color: "ink-green" },
    { label: "Unsigned", value: String(unsignedCount), change: unsignedCount > 0 ? "Awaiting signature" : "All signed!", color: unsignedCount > 0 ? "ink-red" : "ink-green" },
    { label: "Active Drivers", value: String(activeDrivers), change: "With trip sheets", color: "ink-amber" },
  ];

  // Build recent activity from trip sheets
  const recentActivity: { driver: string; customer: string; invoice: string; time: string; status: string }[] = [];
  for (const sheet of tripSheets) {
    for (const stop of sheet.stops) {
      recentActivity.push({
        driver: sheet.driverName,
        customer: stop.customerName,
        invoice: stop.invoiceNumber,
        time: stop.signedAt
          ? new Date(stop.signedAt).toLocaleDateString("en-ZA", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—",
        status: stop.status,
      });
    }
  }

  // Sort: signed first (most recent), then in-progress, then pending
  recentActivity.sort((a, b) => {
    const order = { SIGNED: 0, IN_PROGRESS: 1, PENDING: 2 };
    return (order[a.status as keyof typeof order] ?? 3) - (order[b.status as keyof typeof order] ?? 3);
  });

  return (
    <div className="animate-fade-in">
      {/* Header */}
      <div className="mb-8">
        <h1 className="font-mono text-2xl font-medium text-ink-black tracking-tight">
          Dashboard
        </h1>
        <p className="text-sm text-ink-muted mt-1">
          {new Date().toLocaleDateString("en-ZA", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
          })}
        </p>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-ink-border border-t-ink-green rounded-full animate-spin" />
        </div>
      )}

      {!loading && (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8 stagger-children">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="bg-ink-card border border-ink-border rounded p-5 hover:border-ink-muted-light transition-colors"
              >
                <p className="text-xs font-mono text-ink-muted uppercase tracking-wide mb-3">
                  {stat.label}
                </p>
                <p className={`text-3xl font-mono font-medium text-${stat.color}`}>
                  {stat.value}
                </p>
                <p className="text-xs text-ink-muted mt-1">{stat.change}</p>
              </div>
            ))}
          </div>

          {/* Recent Activity */}
          <div className="bg-ink-card border border-ink-border rounded">
            <div className="px-5 py-4 border-b border-ink-border">
              <h2 className="font-mono text-sm font-medium text-ink-black uppercase tracking-wide">
                Recent Activity
              </h2>
            </div>
            {recentActivity.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <p className="text-sm font-mono text-ink-muted">No activity yet</p>
                <p className="text-xs text-ink-muted mt-1">Upload a trip sheet to see deliveries here</p>
              </div>
            ) : (
              <div className="divide-y divide-ink-border">
                {recentActivity.slice(0, 10).map((item, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-ink-surface/50 transition-colors"
                  >
                    <div className="w-8 h-8 rounded bg-ink-surface flex items-center justify-center shrink-0">
                      <span className="text-xs font-mono font-medium text-ink-muted">
                        {item.driver
                          .split(" ")
                          .map((n) => n[0])
                          .join("")}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-ink-black truncate">
                        {item.customer}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {item.invoice} · {item.driver}
                      </p>
                    </div>
                    <span className="text-xs text-ink-muted font-mono hidden sm:block">
                      {item.time}
                    </span>
                    <span
                      className={
                        item.status === "SIGNED"
                          ? "badge-signed"
                          : item.status === "IN_PROGRESS"
                          ? "badge-progress"
                          : "badge-pending"
                      }
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          item.status === "SIGNED"
                            ? "bg-ink-green"
                            : item.status === "IN_PROGRESS"
                            ? "bg-ink-amber"
                            : "bg-ink-red"
                        }`}
                      />
                      {item.status === "SIGNED"
                        ? "Signed"
                        : item.status === "IN_PROGRESS"
                        ? "In Progress"
                        : "Pending"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
