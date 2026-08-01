/**
 * OneDrive token refresh under concurrency.
 *
 * Microsoft ROTATES refresh tokens: exchanging one invalidates it and issues a
 * replacement. So two concurrent refreshes from the same stored token are not
 * merely wasteful — they produce two different replacements, and whichever
 * writes last wins. The loser's token is already dead, which takes that
 * branch's OneDrive offline until an admin reconnects it by hand.
 *
 * At twenty drivers per branch signing in together, that race is not
 * theoretical. These tests drive it directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TENANT = "tenant-a";

/** Mutable stand-in for the CloudAccount row. */
let row: {
  provider: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
  invoiceFolderItemId: string | null;
};

let tokenExchangeCount = 0;
let updateManyCalls: { where: Record<string, unknown> }[] = [];

/** Encryption is stubbed to a reversible prefix so assertions stay readable. */
vi.mock("@/lib/crypto", () => ({
  encryptToken: (v: string) => `enc(${v})`,
  decryptToken: (v: string) => String(v).replace(/^enc\((.*)\)$/, "$1"),
}));

vi.mock("@/lib/db-scoped", () => ({
  scopedPrisma: () => ({
    cloudAccount: {
      findFirst: async () => ({ ...row }),
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateManyCalls.push({ where: args.where });
        // Compare-and-swap: only apply when the stored refresh token is still
        // the one the caller exchanged.
        if (args.where.refreshToken && args.where.refreshToken !== row.refreshToken) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
  }),
  UNSAFE_unscopedPrisma: {},
}));

// No Redis in tests — the lock degrades to "assume acquired", which is exactly
// the configuration where the compare-and-swap has to carry correctness alone.
vi.mock("@/lib/redis", () => ({ getRedis: () => null, resetRedisForTests: () => {} }));

async function loadModule() {
  vi.resetModules();
  return import("@/lib/microsoft-graph");
}

beforeEach(() => {
  vi.stubEnv("MICROSOFT_CLIENT_ID", "test-client");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "test-secret");

  tokenExchangeCount = 0;
  updateManyCalls = [];

  row = {
    provider: "onedrive",
    accessToken: "enc(old-access)",
    refreshToken: "enc(old-refresh)",
    // Already inside the five-minute refresh window.
    tokenExpiry: new Date(Date.now() + 60_000),
    invoiceFolderItemId: "folder-1",
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      tokenExchangeCount++;
      // Microsoft issues a NEW refresh token each time — the rotation that
      // makes concurrent refreshes destructive.
      const n = tokenExchangeCount;
      return new Response(
        JSON.stringify({
          access_token: `new-access-${n}`,
          refresh_token: `new-refresh-${n}`,
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getValidAccessToken", () => {
  it("exchanges the token only ONCE for many concurrent callers", async () => {
    const { getValidAccessToken } = await loadModule();

    // Twenty drivers hitting the same branch at shift change.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => getValidAccessToken(TENANT))
    );

    expect(tokenExchangeCount).toBe(1);
    // Everyone gets a usable token, and they all get the SAME one.
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe("new-access-1");
  });

  it("stores the rotated refresh token exactly once", async () => {
    const { getValidAccessToken } = await loadModule();

    await Promise.all(Array.from({ length: 10 }, () => getValidAccessToken(TENANT)));

    expect(row.refreshToken).toBe("enc(new-refresh-1)");
    const writes = updateManyCalls.filter((c) => c.where.refreshToken);
    expect(writes).toHaveLength(1);
  });

  it("guards the write with a compare-and-swap on the refresh token", async () => {
    const { getValidAccessToken } = await loadModule();
    await getValidAccessToken(TENANT);

    // The lock can expire mid-flight and Redis may be absent, so the write
    // itself must be conditional — not merely lock-protected.
    expect(updateManyCalls[0].where).toMatchObject({
      provider: "onedrive",
      refreshToken: "enc(old-refresh)",
    });
  });

  it("yields to a competing writer rather than overwriting a newer token", async () => {
    const { getValidAccessToken } = await loadModule();

    // Simulate another instance rotating the token while our exchange is in
    // flight: by the time we write, the stored value has moved on.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        tokenExchangeCount++;
        row.refreshToken = "enc(someone-elses-refresh)";
        row.accessToken = "enc(someone-elses-access)";
        return new Response(
          JSON.stringify({
            access_token: "our-doomed-access",
            refresh_token: "our-doomed-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const token = await getValidAccessToken(TENANT);

    // Ours was invalidated the moment theirs was issued, so theirs must stand.
    expect(row.refreshToken).toBe("enc(someone-elses-refresh)");
    expect(token).toBe("someone-elses-access");
  });

  it("skips the exchange entirely when the token is still fresh", async () => {
    row.tokenExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const { getValidAccessToken } = await loadModule();

    const token = await getValidAccessToken(TENANT);

    expect(tokenExchangeCount).toBe(0);
    expect(token).toBe("old-access");
  });

  it("returns null, not a stale token, when the exchange fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_grant", { status: 400 }))
    );
    const { getValidAccessToken } = await loadModule();

    expect(await getValidAccessToken(TENANT)).toBeNull();
  });

  it("allows a later refresh after an in-flight one settles", async () => {
    const { getValidAccessToken } = await loadModule();

    await getValidAccessToken(TENANT);
    // Push it back into the refresh window and go again — the in-flight entry
    // must have been cleared, or this scope could never refresh twice.
    row.tokenExpiry = new Date(Date.now() + 60_000);
    await getValidAccessToken(TENANT);

    expect(tokenExchangeCount).toBe(2);
  });
});
