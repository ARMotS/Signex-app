/**
 * Prisma client singleton — shared across the application.
 *
 * Prisma 7 requires a driver adapter for direct database connections.
 * We use @prisma/adapter-pg with the node-postgres (pg) driver.
 *
 * ── Serverless connection budget ──────────────────────────────────────────
 * Every warm Vercel instance keeps its OWN pg.Pool, so `max` is a PER-INSTANCE
 * ceiling, not a global one. Vercel scales out under concurrency, so the real
 * connection count is roughly `max × live instances`. A pool of 10 across a
 * handful of instances is enough to exhaust a Neon compute's max_connections,
 * at which point every branch stalls at once.
 *
 * Two rules follow:
 *
 *   1. The RUNTIME connects through Neon's POOLED endpoint — the host
 *      containing `-pooler`. PgBouncer multiplexes many client connections
 *      onto a small number of real Postgres backends, which is what makes
 *      horizontal scale-out safe.
 *
 *   2. MIGRATIONS use the DIRECT endpoint (see prisma.config.ts). They run
 *      once at build time and need a real session for advisory locks and DDL,
 *      neither of which survive a transaction-mode pooler.
 *
 * Env vars, in the order the runtime prefers them:
 *   DATABASE_URL_POOLED  — explicit pooled URL, if you want it unambiguous
 *   DATABASE_URL         — the pooled URL (Prisma/Neon convention)
 *   DATABASE_URL_DIRECT  — last-resort fallback; warns loudly in production
 */

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: pg.Pool | undefined;
};

/**
 * Per-instance pool ceiling. Deliberately small — the pooler does the real
 * fan-out. Raise only if you have measured queueing inside a single instance.
 */
const POOL_MAX = Math.max(1, Number(process.env.DATABASE_POOL_MAX ?? 5));

function isNeon(url: string): boolean {
  return /\.neon\.tech/i.test(url);
}

function isPooled(url: string): boolean {
  return /-pooler\./i.test(url) || /[?&]pgbouncer=true/i.test(url);
}

/**
 * Resolve the URL the application runtime should connect with.
 *
 * Deliberately does NOT throw on a missing URL. This module is imported during
 * `next build` and by unit tests that never touch the database; validating at
 * import time would make a live connection string a build dependency. Same
 * lesson as TOKEN_ENCRYPTION_KEY in lib/crypto.ts. A genuinely absent URL still
 * fails — at first query, where the error names the actual problem.
 */
function resolveRuntimeUrl(): string | undefined {
  const url =
    process.env.DATABASE_URL_POOLED ||
    process.env.DATABASE_URL ||
    process.env.DATABASE_URL_DIRECT;

  if (!url) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "[db] No database URL configured. Set DATABASE_URL to your Neon " +
          "POOLED connection string (the host containing `-pooler`) and " +
          "DATABASE_URL_DIRECT to the direct one for migrations."
      );
    }
    return undefined;
  }

  // Connecting the runtime to a direct Neon endpoint is the single most common
  // cause of connection exhaustion under load. Fail loudly in the logs rather
  // than degrading mysteriously at 3pm on a busy Friday.
  if (process.env.NODE_ENV === "production" && isNeon(url) && !isPooled(url)) {
    console.warn(
      "[db] WARNING: the runtime is connected to a NON-POOLED Neon endpoint. " +
        "Under concurrent load this will exhaust max_connections. Point " +
        "DATABASE_URL at the `-pooler` host and keep the direct host in " +
        "DATABASE_URL_DIRECT (migrations only)."
    );
  }

  return url;
}

function createPool(): pg.Pool {
  const pool = new pg.Pool({
    connectionString: resolveRuntimeUrl(),
    max: POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Keeps sockets alive between warm invocations so a busy instance is not
    // paying TLS setup on every request.
    keepAlive: true,
  });

  // An error on an IDLE client is emitted on the pool, not on any query. Left
  // unhandled it is an unhandled 'error' event, which terminates the process
  // and turns one dropped connection into a cold start for everyone on that
  // instance.
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });

  return pool;
}

function createPrismaClient(): PrismaClient {
  const pool = globalForPrisma.pool ?? createPool();
  globalForPrisma.pool = pool;

  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });
}

/**
 * Cached on globalThis in EVERY environment, not just development.
 *
 * In development this survives HMR. In production it guards against Next
 * instantiating this module more than once across its separate server bundles
 * — each fresh instantiation would otherwise open another pool that nothing
 * ever closes.
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ?? createPrismaClient();

globalForPrisma.prisma = prisma;
