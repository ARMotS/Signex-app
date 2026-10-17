/**
 * The customer cross-check between the trip sheet and the invoice PDF.
 *
 * The sheet's name is always the one shown; this only decides whether to flag
 * it. A false flag on every cash sale would teach the office to ignore it, so
 * the cases that must NOT flag matter as much as the ones that must.
 */

import { describe, it, expect } from "vitest";
import { customerMismatch } from "@/lib/invoice-registry";

describe("customerMismatch", () => {
  it("does not flag a cash sale: the customer is on Deliver to, not Invoice to", () => {
    expect(
      customerMismatch("ATLANTIC AUTO SPARES", "ATLANTIC AUTO SPARES(LANGLAAG)", "CASH SALES JHB")
    ).toBe(false);
  });

  it.each([
    ["Newlands Auto Spares", "NEWLANDS AUTO SPARES (PTY) LTD"],
    ["Bennbliss Auto", "BENNBLISS AUTO CC"],
    ["AUTO PRIME 5 SPARES", "Auto Prime 5 Spares"],
  ])("does not flag %s against %s", (sheet, pdf) => {
    expect(customerMismatch(sheet, pdf, null)).toBe(false);
  });

  it("flags a customer the PDF does not name at all", () => {
    expect(customerMismatch("BENNBLISS AUTO", "ATLANTIC AUTO SPARES(LANGLAAG)", "CASH SALES JHB")).toBe(true);
  });

  it("does not flag before the PDF has been read, or with no sheet name", () => {
    expect(customerMismatch("BENNBLISS AUTO", null, null)).toBe(false);
    expect(customerMismatch(null, "ATLANTIC AUTO SPARES", null)).toBe(false);
  });

  it("does not let a very short name match by containment", () => {
    expect(customerMismatch("AB", "ABBA MOTORS", null)).toBe(true);
  });
});
