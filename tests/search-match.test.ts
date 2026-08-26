/**
 * The narrowing behind the search boxes on the Invoices and Trip Sheet pages.
 *
 * The cases that matter are the ones a dispatcher hits while reading a number
 * off a delivery note: half an invoice number, the wrong punctuation, or two
 * words that live in different columns.
 */

import { describe, it, expect } from "vitest";
import { tokenizeQuery, matchesTokens, matchesQuery } from "@/lib/search-match";

describe("tokenizeQuery", () => {
  it("splits on whitespace and lower-cases", () => {
    expect(tokenizeQuery("  INV 4471  ")).toEqual(["inv", "4471"]);
  });

  it("returns nothing for an empty box", () => {
    expect(tokenizeQuery("")).toEqual([]);
    expect(tokenizeQuery("   ")).toEqual([]);
  });
});

describe("matchesQuery", () => {
  it("hides nothing when the box is empty", () => {
    expect(matchesQuery("", "anything")).toBe(true);
    expect(matchesQuery("   ", null)).toBe(true);
  });

  it("ignores case", () => {
    expect(matchesQuery("smith", "SMITH HARDWARE")).toBe(true);
  });

  it("matches a fragment, not just a prefix", () => {
    expect(matchesQuery("4471", "INV-004471.pdf")).toBe(true);
  });

  it("treats punctuation inside a reference as noise", () => {
    expect(matchesQuery("inv-4471", "INV4471.pdf")).toBe(true);
    expect(matchesQuery("inv4471", "INV-4471.pdf")).toBe(true);
    expect(matchesQuery("inv 4471", "INV-4471.pdf")).toBe(true);
  });

  it("requires every word, in any order and across any field", () => {
    expect(matchesQuery("smith 4471", "INV-4471", "Smith Hardware")).toBe(true);
    expect(matchesQuery("4471 smith", "INV-4471", "Smith Hardware")).toBe(true);
    // The invoice belongs to someone else — one word missing is no match.
    expect(matchesQuery("smith 4471", "INV-9999", "Smith Hardware")).toBe(false);
  });

  it("does not let a word straddle two fields", () => {
    // "Smith" and "4471" are separate columns: squashing them together must
    // not manufacture "smith4471".
    expect(matchesQuery("smith4471", "Smith", "4471")).toBe(false);
  });

  it("skips absent fields rather than matching on them", () => {
    expect(matchesQuery("smith", null, undefined, "")).toBe(false);
    expect(matchesQuery("smith", null, "Smith Hardware")).toBe(true);
  });

  it("accepts numbers as fields", () => {
    expect(matchesQuery("12", 4412)).toBe(true);
  });

  it("matches a bare punctuation query literally", () => {
    // squash() leaves nothing, so the raw substring is all there is to go on.
    expect(matchesQuery("-", "INV-4471")).toBe(true);
    expect(matchesQuery("-", "INV4471")).toBe(false);
  });
});

describe("matchesTokens", () => {
  it("is what a list uses to tokenise once and test many rows", () => {
    const tokens = tokenizeQuery("acme 88");
    const rows = [
      ["INV-0088", "Acme Ltd"],
      ["INV-8800", "Acme Ltd"],
      ["INV-0088", "Beta Supplies"],
    ];
    expect(rows.map((r) => matchesTokens(tokens, r))).toEqual([true, true, false]);
  });
});
