/**
 * Health checks for uptime monitoring and deploy verification.
 *
 * ── What "healthy" means here ─────────────────────────────────────────────
 * The two dependencies are not equal, and the report says so:
 *
 *   - Postgres DOWN means the application cannot function at all. Nothing can
 *     be read or written, so this reports `down` and the endpoint answers 503
 *     to take the instance out of rotation.
 *
 *   - Redis DOWN is `degraded`, not `down`. Rate limiting falls back to
 *     per-instance counters and the OneDrive refresh lock degrades to its
 *     compare-and-swap — both by design (see lib/rate-limit.ts and lib/lock.ts).
 *     Drivers keep signing. Reporting this as an outage would page somebody at
 *     3am for something that is not stopping deliveries.
 *
 * ── What it must never expose ─────────────────────────────────────────────
 * The endpoint is unauthenticated so an uptime monitor can reach it. It
 * therefore reports only status and latency — never connection strings, driver
 * error text, row counts or anything else that describes a tenant's data.
 */

import { UNSAFE_unscopedPrisma } from "./db-scoped";
import { getRedis } from "./redis";

export type CheckStatus = "ok" | "degraded" | "down";

export interface HealthCheck {
  status: CheckStatus;
  latencyMs: number;
  /** A short, fixed reason code. Never a raw error message. */
  reason?: string;
}

export interface HealthReport {
  status: CheckStatus;
  checks: {
    database: HealthCheck;
    redis: HealthCheck;
  };
}

/** A hung dependency must not hang the health check itself. */
const CHECK_TIMEOUT_MS = 3000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function checkDatabase(): Promise<HealthCheck> {
  const started = Date.now();
  try {
    // SCOPE-EXEMPT: liveness probe. Selects a literal and reads no rows from any
    // table, so there is no tenant data for a scope to apply to.
    await withTimeout(
      UNSAFE_unscopedPrisma.$queryRaw`SELECT 1`,
      CHECK_TIMEOUT_MS
    );
    return { status: "ok", latencyMs: Date.now() - started };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Date.now() - started,
      reason: err instanceof Error && err.message === "timeout" ? "timeout" : "unreachable",
    };
  }
}

export async function checkRedis(): Promise<HealthCheck> {
  const started = Date.now();
  const redis = getRedis();

  // Not configured is a deployment choice, not a fault. It still degrades the
  // guarantees, so it is reported rather than shown as healthy.
  if (!redis) {
    return { status: "degraded", latencyMs: 0, reason: "not-configured" };
  }

  try {
    await withTimeout(redis.ping(), CHECK_TIMEOUT_MS);
    return { status: "ok", latencyMs: Date.now() - started };
  } catch (err) {
    return {
      status: "degraded",
      latencyMs: Date.now() - started,
      reason: err instanceof Error && err.message === "timeout" ? "timeout" : "unreachable",
    };
  }
}

/**
 * Roll individual checks into one verdict.
 *
 * Pure, so the escalation rules can be tested without a database or a cache.
 */
export function summarize(checks: HealthReport["checks"]): CheckStatus {
  // The database is load-bearing: if it is down, so is the application.
  if (checks.database.status === "down") return "down";

  if (
    checks.database.status === "degraded" ||
    checks.redis.status === "degraded" ||
    checks.redis.status === "down"
  ) {
    return "degraded";
  }

  return "ok";
}

export async function getHealthReport(): Promise<HealthReport> {
  const [database, redis] = await Promise.all([checkDatabase(), checkRedis()]);
  const checks = { database, redis };
  return { status: summarize(checks), checks };
}
