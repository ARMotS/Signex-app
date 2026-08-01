#!/usr/bin/env node
/**
 * Concurrency smoke test.
 *
 * Simulates the shape of real load — five branches, twenty drivers each, all
 * polling the change feed — and reports what actually happens: latency spread,
 * error rate, and how many requests get rate limited.
 *
 * It exists because every fix in this effort was reasoned about rather than
 * measured. This is the measurement.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   node scripts/smoke-concurrency.mjs --url https://signex-app.vercel.app
 *
 *   # Authenticated run against the real polling endpoint (the useful one).
 *   # Copy the `signex-session` cookie value from your browser dev tools.
 *   node scripts/smoke-concurrency.mjs \
 *     --url https://signex-app.vercel.app \
 *     --path /api/sync \
 *     --cookie "signex-session=<value>" \
 *     --concurrency 25 --requests 500
 *
 * ── Reading the result ────────────────────────────────────────────────────
 *   p95 is the number that matters — the slowest 1 in 20 requests is what a
 *   driver actually notices.
 *
 *   Any 429 during a run sized like real traffic means the limits from
 *   lib/rate-limit.ts are too tight for the way the app now polls.
 *
 *   Any 5xx is a genuine failure and should be zero.
 *
 * Read-only: it issues GETs. Do not point the write paths at production.
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const BASE = (args.get("url") || "http://localhost:3000").replace(/\/$/, "");
const PATH = args.get("path") || "/api/health";
const COOKIE = args.get("cookie") || "";
const CONCURRENCY = Number(args.get("concurrency") || 25);
const TOTAL = Number(args.get("requests") || 300);

if (!COOKIE && PATH !== "/api/health") {
  console.error(
    "Refusing to run: %s needs a session. Pass --cookie \"signex-session=...\"",
    PATH
  );
  process.exit(1);
}

const latencies = [];
const statusCounts = new Map();
let networkErrors = 0;
let issued = 0;

function record(status) {
  statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
}

async function worker() {
  while (true) {
    const index = issued++;
    if (index >= TOTAL) return;

    const started = performance.now();
    try {
      const res = await fetch(`${BASE}${PATH}`, {
        headers: COOKIE ? { Cookie: COOKIE } : undefined,
        cache: "no-store",
      });
      // Drain the body so the timing includes the full response.
      await res.arrayBuffer().catch(() => {});
      latencies.push(performance.now() - started);
      record(res.status);
    } catch {
      networkErrors++;
      latencies.push(performance.now() - started);
    }
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

const ms = (n) => `${n.toFixed(0)}ms`;

console.log(
  `\nSignex concurrency smoke test\n` +
    `  target      ${BASE}${PATH}\n` +
    `  requests    ${TOTAL}\n` +
    `  concurrency ${CONCURRENCY}\n` +
    `  session     ${COOKIE ? "yes" : "no (anonymous)"}\n`
);

const wallStart = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const wallMs = performance.now() - wallStart;

const sorted = latencies.slice().sort((a, b) => a - b);
const throttled = statusCounts.get(429) || 0;
const serverErrors = [...statusCounts.entries()]
  .filter(([s]) => s >= 500)
  .reduce((n, [, c]) => n + c, 0);

console.log("Latency");
console.log(`  p50   ${ms(percentile(sorted, 50))}`);
console.log(`  p95   ${ms(percentile(sorted, 95))}`);
console.log(`  p99   ${ms(percentile(sorted, 99))}`);
console.log(`  max   ${ms(sorted[sorted.length - 1] ?? 0)}`);
console.log(`\nThroughput`);
console.log(`  ${(TOTAL / (wallMs / 1000)).toFixed(1)} req/s over ${ms(wallMs)}`);

console.log("\nStatus codes");
for (const [status, count] of [...statusCounts.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${status}  ${count}`);
}
if (networkErrors) console.log(`  network errors  ${networkErrors}`);

console.log("\nVerdict");
const problems = [];
if (serverErrors > 0) problems.push(`${serverErrors} server error(s) — investigate before deploying`);
if (throttled > 0) problems.push(`${throttled} request(s) rate limited — limits may be too tight for real polling`);
if (networkErrors > 0) problems.push(`${networkErrors} network error(s)`);

if (problems.length === 0) {
  console.log("  clean — no throttling, no server errors\n");
} else {
  for (const p of problems) console.log(`  ! ${p}`);
  console.log("");
}

process.exit(serverErrors > 0 || networkErrors > 0 ? 1 : 0);
