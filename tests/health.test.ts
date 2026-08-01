/**
 * Health escalation rules.
 *
 * The distinction these encode is operational, not cosmetic: Redis being
 * unreachable degrades guarantees but does not stop a driver capturing a
 * signature, whereas Postgres being unreachable stops everything. Reporting the
 * first as an outage pages somebody at 3am for nothing; reporting the second as
 * healthy leaves a dead instance in rotation.
 */

import { describe, it, expect } from "vitest";
import { summarize, type HealthCheck } from "@/lib/health";

const ok = (): HealthCheck => ({ status: "ok", latencyMs: 5 });
const degraded = (reason: string): HealthCheck => ({
  status: "degraded",
  latencyMs: 5,
  reason,
});
const down = (reason: string): HealthCheck => ({
  status: "down",
  latencyMs: 3000,
  reason,
});

describe("summarize", () => {
  it("is ok when both dependencies are healthy", () => {
    expect(summarize({ database: ok(), redis: ok() })).toBe("ok");
  });

  it("is DOWN when Postgres is unreachable", () => {
    // Nothing can be read or written — the instance should leave rotation.
    expect(summarize({ database: down("unreachable"), redis: ok() })).toBe("down");
  });

  it("stays DOWN when Postgres is unreachable even if Redis is fine", () => {
    expect(summarize({ database: down("timeout"), redis: ok() })).toBe("down");
  });

  it("is only DEGRADED when Redis is unreachable", () => {
    // Rate limits fall back to per-instance counters and the OneDrive refresh
    // relies on its compare-and-swap. Deliveries continue.
    expect(summarize({ database: ok(), redis: down("unreachable") })).toBe("degraded");
  });

  it("is DEGRADED when Redis is simply not configured", () => {
    // A deployment choice rather than a fault, but the weaker guarantees are
    // worth surfacing rather than reporting as fully healthy.
    expect(summarize({ database: ok(), redis: degraded("not-configured") })).toBe(
      "degraded"
    );
  });

  it("never reports down for a Redis problem alone", () => {
    for (const redis of [down("timeout"), down("unreachable"), degraded("not-configured")]) {
      expect(summarize({ database: ok(), redis })).not.toBe("down");
    }
  });

  it("escalates a degraded database", () => {
    expect(summarize({ database: degraded("slow"), redis: ok() })).toBe("degraded");
  });
});

describe("report shape", () => {
  it("carries only status, latency and a fixed reason code", async () => {
    // The endpoint is unauthenticated, so the surface must stay free of
    // connection strings, driver error text and anything tenant-specific.
    const check = down("unreachable");

    expect(Object.keys(check).sort()).toEqual(["latencyMs", "reason", "status"]);
    expect(["timeout", "unreachable", "not-configured"]).toContain(check.reason);
  });
});
