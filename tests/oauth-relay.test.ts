/**
 * A OneDrive connect started on a preview deployment comes back to production's
 * registered callback, which hands it back to the preview — but only to an
 * origin carried in a signed state, and only to a deployment we would run.
 */

import { describe, it, expect, afterEach } from "vitest";
import { signOAuthState, verifyOAuthState } from "@/lib/crypto";
import { isRelayableOrigin, oauthRelayOrigin } from "@/lib/oauth-relay";

const PROD = "https://signex-app.vercel.app";
const PREVIEW = "https://signex-app-git-feat-collections-team.vercel.app";

afterEach(() => {
  delete process.env.OAUTH_RETURN_ORIGINS;
});

describe("OAuth state carries the origin that started the flow", () => {
  it("round-trips the return origin under the signature", () => {
    expect(verifyOAuthState(signOAuthState("tenant-a", PREVIEW))).toEqual({
      tenantId: "tenant-a",
      returnOrigin: PREVIEW,
    });
  });

  it("rejects a state whose return origin was swapped after signing", () => {
    const [, sig] = signOAuthState("tenant-a", PREVIEW).split(".");
    const swapped = Buffer.from(
      JSON.stringify({ tenantId: "tenant-a", ret: "https://evil.example", nonce: "x", exp: Date.now() + 60000 })
    ).toString("base64url");
    expect(verifyOAuthState(`${swapped}.${sig}`)).toBeNull();
  });
});

describe("oauthRelayOrigin", () => {
  it("forwards a preview's flow from production back to the preview", () => {
    expect(oauthRelayOrigin(PROD, signOAuthState("tenant-a", PREVIEW))).toBe(PREVIEW);
  });

  it("handles a flow locally when it started here", () => {
    expect(oauthRelayOrigin(PROD, signOAuthState("tenant-a", PROD))).toBeNull();
    // The preview receiving the forwarded request must not bounce it again.
    expect(oauthRelayOrigin(PREVIEW, signOAuthState("tenant-a", PREVIEW))).toBeNull();
  });

  it("handles a state with no origin (issued before this change) locally", () => {
    expect(oauthRelayOrigin(PROD, signOAuthState("tenant-a"))).toBeNull();
  });

  it("never forwards on an unsigned or forged state", () => {
    const payload = Buffer.from(
      JSON.stringify({ tenantId: "tenant-a", ret: PREVIEW, nonce: "x", exp: Date.now() + 60000 })
    ).toString("base64url");
    expect(oauthRelayOrigin(PROD, `${payload}.deadbeef`)).toBeNull();
    expect(oauthRelayOrigin(PROD, null)).toBeNull();
  });

  it("never forwards to an origin outside the allowlist, even when signed", () => {
    expect(oauthRelayOrigin(PROD, signOAuthState("tenant-a", "https://evil.example"))).toBeNull();
  });
});

describe("isRelayableOrigin", () => {
  it("accepts Vercel deployments over https and local dev", () => {
    expect(isRelayableOrigin(PREVIEW)).toBe(true);
    expect(isRelayableOrigin("http://localhost:3000")).toBe(true);
  });

  it("refuses look-alikes, plain http on Vercel, and anything but a bare origin", () => {
    expect(isRelayableOrigin("https://vercel.app.evil.example")).toBe(false);
    expect(isRelayableOrigin("https://evilvercel.app")).toBe(false);
    expect(isRelayableOrigin("http://signex-app-x.vercel.app")).toBe(false);
    expect(isRelayableOrigin(`${PREVIEW}/somewhere`)).toBe(false);
    expect(isRelayableOrigin("https://user@x.vercel.app")).toBe(false);
    expect(isRelayableOrigin("not a url")).toBe(false);
  });

  it("accepts an origin listed in OAUTH_RETURN_ORIGINS", () => {
    expect(isRelayableOrigin("https://staging.signex.example")).toBe(false);
    process.env.OAUTH_RETURN_ORIGINS = "https://other.example, https://staging.signex.example";
    expect(isRelayableOrigin("https://staging.signex.example")).toBe(true);
  });
});
