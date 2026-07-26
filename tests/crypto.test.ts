/**
 * Token encryption at rest, and the signed OAuth state that binds a OneDrive
 * authorization round-trip to one scope.
 */

import { describe, it, expect } from "vitest";
import {
  encryptToken,
  decryptToken,
  isEncrypted,
  signOAuthState,
  verifyOAuthState,
} from "@/lib/crypto";

describe("OneDrive token encryption", () => {
  it("round-trips a token", () => {
    const token = "EwB4A8l6BAAU...a-realistic-looking-graph-token";
    expect(decryptToken(encryptToken(token))).toBe(token);
  });

  it("never stores the plaintext", () => {
    const token = "super-secret-refresh-token";
    const cipher = encryptToken(token);
    expect(cipher).not.toContain(token);
    expect(cipher.startsWith("v1:")).toBe(true);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const token = "same-input";
    expect(encryptToken(token)).not.toBe(encryptToken(token));
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const cipher = encryptToken("sensitive");
    const parts = cipher.split(":");
    // Flip the last byte of the payload.
    const flipped = parts[3].slice(0, -2) + (parts[3].endsWith("00") ? "ff" : "00");
    const tampered = [parts[0], parts[1], parts[2], flipped].join(":");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("rejects a malformed value", () => {
    expect(() => decryptToken("not-encrypted-at-all")).toThrow(
      /Malformed encrypted token/
    );
  });

  it("recognises encrypted vs plaintext, so the backfill is idempotent", () => {
    expect(isEncrypted(encryptToken("x"))).toBe(true);
    expect(isEncrypted("plaintext-token")).toBe(false);
  });
});

describe("OAuth state binds a connect flow to one scope", () => {
  it("round-trips the scope it was issued for", () => {
    expect(verifyOAuthState(signOAuthState("tenant-a"))).toEqual({
      tenantId: "tenant-a",
    });
  });

  it("is unique per call, so a state cannot be replayed by guessing", () => {
    expect(signOAuthState("tenant-a")).not.toBe(signOAuthState("tenant-a"));
  });

  it("rejects an unsigned or forged state", () => {
    const payload = Buffer.from(
      JSON.stringify({ tenantId: "tenant-b", nonce: "x", exp: Date.now() + 60000 })
    ).toString("base64url");
    // Attacker-authored payload with a bogus signature.
    expect(verifyOAuthState(`${payload}.deadbeef`)).toBeNull();
  });

  it("rejects a state whose scope was swapped after signing", () => {
    const valid = signOAuthState("tenant-a");
    const [, sig] = valid.split(".");
    const swapped = Buffer.from(
      JSON.stringify({ tenantId: "tenant-b", nonce: "x", exp: Date.now() + 60000 })
    ).toString("base64url");
    expect(verifyOAuthState(`${swapped}.${sig}`)).toBeNull();
  });

  it("rejects a missing state", () => {
    expect(verifyOAuthState(null)).toBeNull();
    expect(verifyOAuthState("")).toBeNull();
  });

  it("rejects a garbage state without throwing", () => {
    expect(verifyOAuthState("....")).toBeNull();
    expect(verifyOAuthState("no-dot-here")).toBeNull();
  });
});
