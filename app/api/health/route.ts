import { NextResponse } from "next/server";
import { getHealthReport } from "@/lib/health";

/**
 * GET /api/health — liveness and dependency check.
 *
 * Deliberately UNAUTHENTICATED so an uptime monitor and Vercel's own checks can
 * reach it. It therefore reports status and latency only — never connection
 * details, error text, or anything describing a tenant's data.
 *
 * Status codes are what a monitor keys on:
 *   200 ok        — everything healthy
 *   200 degraded  — Redis unavailable; rate limiting and the OneDrive refresh
 *                   lock fall back, but drivers keep signing. Not an outage.
 *   503 down      — Postgres unreachable; this instance can serve nothing and
 *                   should be taken out of rotation.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const report = await getHealthReport();

  return NextResponse.json(report, {
    status: report.status === "down" ? 503 : 200,
    headers: {
      // A cached health check is worse than none at all.
      "Cache-Control": "no-store, must-revalidate",
    },
  });
}
