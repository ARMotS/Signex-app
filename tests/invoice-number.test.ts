/**
 * normalizeInvoiceNo — the one number every document is matched on.
 *
 * The invoice PDF prints INV-2026-1047; the trip sheet, the collection sheet
 * and the credit note print 1047. If these disagree, a stop shows "no PDF" for
 * a PDF that is sitting in the folder, or a credit note never finds the
 * collection it settles.
 */

import { describe, it, expect } from "vitest";
import {
  buildInvoiceLookup,
  compileInvoiceNoPattern,
  invoiceMatchKeys,
  matchInvoiceFile,
  normalizeInvoiceNo,
  normalizedInvoiceNoOrNull,
  type InvoiceNoPattern,
} from "@/lib/invoice-number";

const files = (...names: string[]) =>
  names.map((filename) => ({
    filename,
    invoiceNumber: filename.replace(/\.pdf$/i, "").toUpperCase(),
  }));

function compiled(source: string): InvoiceNoPattern {
  const result = compileInvoiceNoPattern(source);
  if (!result.ok) throw new Error(result.error);
  return result.pattern;
}

describe("normalizeInvoiceNo — built-in rule", () => {
  it.each([
    ["INV-2026-1047", "1047"],
    ["1047", "1047"],
    ["IV-1047-2026", "1047"],
    ["inv 1047", "1047"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeInvoiceNo(raw)).toBe(expected);
  });

  it.each([
    ["INV-2026-1047.pdf", "1047"],
    ["INV-2026-1047 (1)", "1047"],
    ["INV-2026-1047-2", "1047"], // leading year and a copy counter
    ["INV/2026/1047", "1047"],
    ["Tax Invoice 1047", "1047"],
    ["Invoice # 001047", "1047"], // leading zeros dropped
    ["IV-365-4", "365"], // trailing copy counter, as before
    ["IV-633291", "633291"],
    ["IV-1010-1999", "1010"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeInvoiceNo(raw)).toBe(expected);
  });

  it("keeps a 1–3 digit tail after a year as a copy counter", () => {
    // Unchanged from before the leading-year rule: invoice 2026, copy 4.
    expect(normalizeInvoiceNo("IV-2026-4")).toBe("2026");
  });

  it("reads the part nearer the current year as the year when both look like one", () => {
    // Invoice numbers pass through 1900–2099 long before the calendar does.
    expect(normalizeInvoiceNo("IV-1950-2026")).toBe("1950");
    expect(normalizeInvoiceNo("INV-2026-1950")).toBe("1950");
  });

  it("keeps a 4-digit tail that is not a year as part of the number", () => {
    expect(normalizeInvoiceNo("IV-1010-5678")).toBe("10105678");
  });

  it("is empty for a value with no digits, null for the column", () => {
    expect(normalizeInvoiceNo("")).toBe("");
    expect(normalizeInvoiceNo("N/A")).toBe("");
    expect(normalizedInvoiceNoOrNull("")).toBeNull();
    expect(normalizedInvoiceNoOrNull(null)).toBeNull();
    expect(normalizedInvoiceNoOrNull("INV-2026-1047")).toBe("1047");
  });
});

describe("matching the sheet's 1047 to INV-2026-1047.pdf", () => {
  it.each(["1047", "INV-2026-1047", "inv 1047", "IV-1047"])("%s finds it", (sheet) => {
    const lookup = buildInvoiceLookup(files("INV-2026-1046.pdf", "INV-2026-1047.pdf", "INV-2026-1048.pdf"));
    expect(matchInvoiceFile(lookup, sheet)).toBe("INV-2026-1047.pdf");
  });

  it("still prefers the exact file when two differ only in the year", () => {
    const lookup = buildInvoiceLookup(files("INV-2025-1047.pdf", "INV-2026-1047.pdf"));
    expect(matchInvoiceFile(lookup, "INV-2026-1047")).toBe("INV-2026-1047.pdf");
    expect(matchInvoiceFile(lookup, "INV-2025-1047")).toBe("INV-2025-1047.pdf");
  });
});

describe("a tenant's custom pattern", () => {
  it("takes the named group, else the first group", () => {
    expect(normalizeInvoiceNo("ACME/1047/B", compiled("^ACME/(?<num>\\d+)/"))).toBe("1047");
    expect(normalizeInvoiceNo("ACME/1047/B", compiled("^ACME/(\\d+)/"))).toBe("1047");
  });

  it("falls back to the built-in rule where it does not match", () => {
    // A pattern describes the decorated form; the sheet's bare 1047 still works.
    const pattern = compiled("^ACME/(\\d+)/");
    expect(normalizeInvoiceNo("1047", pattern)).toBe("1047");
    expect(normalizeInvoiceNo("INV-2026-1047", pattern)).toBe("1047");
  });

  it("settles an ambiguous shape the built-in rule cannot", () => {
    // This tenant's numbers really are YEAR-NUMBER with short numbers.
    const pattern = compiled("^INV-\\d{4}-(\\d+)$");
    expect(normalizeInvoiceNo("INV-2026-47")).toBe("2026");
    expect(normalizeInvoiceNo("INV-2026-47", pattern)).toBe("47");
  });

  it("runs on both sides of a match", () => {
    const pattern = compiled("^INV-\\d{4}-(\\d+)$");
    const lookup = buildInvoiceLookup(files("INV-2026-47.pdf"), 3, pattern);
    expect(matchInvoiceFile(lookup, "47", 3, pattern)).toBe("INV-2026-47.pdf");
    // Without it, the built-in rule reads that file as invoice 2026, copy 47.
    expect(matchInvoiceFile(buildInvoiceLookup(files("INV-2026-47.pdf")), "47")).toBeUndefined();
  });

  it("is case-insensitive and keeps the exact key as the strongest", () => {
    const pattern = compiled("^inv-\\d{4}-(\\d+)$");
    expect(invoiceMatchKeys("INV-2026-47", pattern)).toEqual(["202647", "47", "202647", "47"]);
  });
});

describe("compileInvoiceNoPattern", () => {
  it("treats an empty pattern as the built-in rule", () => {
    expect(compileInvoiceNoPattern("")).toEqual({ ok: true, pattern: null });
    expect(compileInvoiceNoPattern("   ")).toEqual({ ok: true, pattern: null });
  });

  it.each([
    ["INV-\\d{4}-(\\d+)", true],
    ["^(?<num>\\d+)-\\d{4}$", true],
    ["(\\d+)?-x", true], // an optional group is not a repetition
    ["INV-\\d+", false], // no capture group
    ["INV-(\\d+", false], // does not compile
    ["(\\d+)+", false], // repeated group: exponential backtracking
    ["(a|b)*(\\d+)", false],
    ["(\\d){2,}", false],
    ["(\\d+)-\\1", false], // backreference
    ["(?<n>\\d+)\\k<n>", false],
    [`(${"\\d".repeat(150)})`, false], // too long
  ])("%s → ok=%s", (source, ok) => {
    expect(compileInvoiceNoPattern(source).ok).toBe(ok);
  });

  it("skips the pattern on an implausibly long input", () => {
    const pattern = compiled("(\\d+)");
    const long = `INV-2026-1047${"x".repeat(80)}`;
    // Built-in rule only: the custom pattern never sees an input that long.
    expect(normalizeInvoiceNo(long, pattern)).toBe(normalizeInvoiceNo(long));
  });
});
