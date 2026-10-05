import { describe, it, expect } from "vitest";
import {
  normalizeUsername,
  validateUsername,
  validatePassword,
  homePathForRole,
} from "@/lib/credentials";

describe("normalizeUsername", () => {
  it("lowercases and trims, so JDoe and jdoe are the same name", () => {
    expect(normalizeUsername("  JDoe ")).toBe("jdoe");
    expect(normalizeUsername("jdoe")).toBe("jdoe");
  });

  it("turns anything that is not a string into an empty name", () => {
    expect(normalizeUsername(undefined)).toBe("");
    expect(normalizeUsername(42)).toBe("");
    expect(normalizeUsername({ username: "x" })).toBe("");
  });
});

describe("validateUsername", () => {
  it.each(["abc", "j.doe", "j_doe", "driver42", "a".repeat(30), "  MiXeD.Case  "])(
    "accepts %j",
    (name) => {
      expect(validateUsername(name)).toBeNull();
    }
  );

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(31)],
    ["a space inside", "j doe"],
    ["a dash", "j-doe"],
    ["an @", "j@doe"],
    ["a non-ASCII letter", "josé"],
    ["empty", ""],
  ])("rejects a name with %s", (_label, name) => {
    expect(validateUsername(name)).not.toBeNull();
  });

  it("matches the database's CHECK constraint exactly", () => {
    // The migration's constraint is ^[a-z0-9._]{3,30}$ on the stored form.
    const dbAccepts = (stored: string) => /^[a-z0-9._]{3,30}$/.test(stored);
    for (const raw of ["Abc", "a.b_c9", "x".repeat(30), "ab", "a-b", "x".repeat(31)]) {
      expect(validateUsername(raw) === null).toBe(dbAccepts(normalizeUsername(raw)));
    }
  });
});

describe("validatePassword", () => {
  it("accepts 8+ characters with a letter and a number", () => {
    expect(validatePassword("abcdefg1")).toBeNull();
    expect(validatePassword("1234567a")).toBeNull();
  });

  it.each([
    ["shorter than 8", "abc123"],
    ["no number", "abcdefgh"],
    ["no letter", "12345678"],
    ["not a string", undefined],
    ["absurdly long", "a1".repeat(101)],
  ])("rejects a password that is %s", (_label, pw) => {
    expect(validatePassword(pw)).not.toBeNull();
  });
});

describe("homePathForRole", () => {
  it("sends each role to its own side of the app", () => {
    expect(homePathForRole("super_admin")).toBe("/users");
    expect(homePathForRole("admin")).toBe("/dashboard");
    expect(homePathForRole("driver")).toBe("/run");
  });

  it("sends anything unrecognised to the login", () => {
    expect(homePathForRole(undefined)).toBe("/login");
    expect(homePathForRole("SUPER_ADMIN")).toBe("/login");
  });
});
