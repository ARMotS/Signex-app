/**
 * INVOICENO → invoice PDF matching.
 *
 * Depots write the same invoice many ways, and the PDF in the folder is named
 * yet another way. A miss here shows up as "no PDF" on a stop whose PDF is
 * sitting in the folder, and the missing-invoice gate then refuses the deploy.
 */

import { describe, it, expect } from "vitest";
import {
  buildInvoiceLookup,
  matchInvoiceFile,
  normalizeInvoiceNo,
  invoiceMatchKeys,
  isPlaceholderCell,
} from "@/lib/trip-parser";

const files = (...names: string[]) =>
  names.map((filename) => ({
    filename,
    invoiceNumber: filename.replace(/\.pdf$/i, "").toUpperCase(),
  }));

describe("matching a sheet's invoice number to a PDF", () => {
  it.each(["IV-365-4", "INV-365-4", "INVOICE-365", "INVOICE 365", "365", "Invoice # 365", "Invoice No. 365", "iv365"])(
    "%s finds IV-365-4.pdf",
    (sheet) => {
      const lookup = buildInvoiceLookup(files("IV-365-4.pdf", "IV-366-1.pdf"));
      expect(matchInvoiceFile(lookup, sheet)).toBe("IV-365-4.pdf");
    }
  );

  it.each(["IV-633291", "633291", "INV-633291", "INVOICE 633291", "IV 633291"])(
    "%s finds IV-633291.pdf",
    (sheet) => {
      const lookup = buildInvoiceLookup(files("IV-633291.pdf"));
      expect(matchInvoiceFile(lookup, sheet)).toBe("IV-633291.pdf");
    }
  );

  // The depot names PDFs IV-<number>-<year> while the sheet writes the bare
  // number. Before the year was read as a suffix, every one of these missed.
  it.each(["1010", "IV-1010", "INV 1010", "IV-1010-2026"])(
    "%s finds IV-1010-2026.pdf",
    (sheet) => {
      const lookup = buildInvoiceLookup(
        files("IV-1009-2026.pdf", "IV-1010-2026.pdf", "IV-1011-2026.pdf", "IV-701-2026.pdf")
      );
      expect(matchInvoiceFile(lookup, sheet)).toBe("IV-1010-2026.pdf");
    }
  );

  it("reads only a plausible year as a 4-digit suffix", () => {
    expect(normalizeInvoiceNo("IV-1010-2026")).toBe("1010");
    expect(normalizeInvoiceNo("IV-1010-1999")).toBe("1010");
    // Not a year: still part of the invoice number.
    expect(normalizeInvoiceNo("IV-1010-5678")).toBe("10105678");
    expect(matchInvoiceFile(buildInvoiceLookup(files("IV-1010-5678.pdf")), "1010")).toBeUndefined();
  });

  it("ignores the trailing -N for assignment", () => {
    expect(normalizeInvoiceNo("IV-365-4")).toBe("365");
    expect(normalizeInvoiceNo("INV-365-4.pdf")).toBe("365");
    expect(normalizeInvoiceNo("IV-633291")).toBe("633291");
  });

  it("still prefers an exact name when two files differ only in the suffix", () => {
    const lookup = buildInvoiceLookup(files("IV-365-4.pdf", "IV-365-5.pdf"));
    expect(matchInvoiceFile(lookup, "IV-365-5")).toBe("IV-365-5.pdf");
    expect(matchInvoiceFile(lookup, "IV-365-4")).toBe("IV-365-4.pdf");
  });

  it("matches across leading zeros and duplicate-copy names", () => {
    expect(matchInvoiceFile(buildInvoiceLookup(files("IV-000365-4.pdf")), "365")).toBe("IV-000365-4.pdf");
    expect(matchInvoiceFile(buildInvoiceLookup(files("IV-365-4 (1).pdf")), "IV-365-4")).toBe("IV-365-4 (1).pdf");
  });

  it("keeps distinct invoices apart", () => {
    const lookup = buildInvoiceLookup(files("INV-2041.pdf", "INV-2042.pdf"));
    expect(matchInvoiceFile(lookup, "2042")).toBe("INV-2042.pdf");
    expect(matchInvoiceFile(lookup, "2043")).toBeUndefined();
  });

  it("does not strip a prefix that is not followed by digits", () => {
    // The exact key keeps the letters; the normalized number is digits only.
    expect(invoiceMatchKeys("SIGMA-12")[0]).toBe("SIGMA12");
    expect(normalizeInvoiceNo("SIGMA-12")).toBe("12");
  });
});

describe("placeholder cells", () => {
  it.each(["0", "00", "O", "o", "-", "--", "–", "‐", "N/A", "nil", " 0 "])("reads %j as empty", (v) => {
    expect(isPlaceholderCell(v)).toBe(true);
  });

  it.each(["10", "INV-0", "COL-118", "0365"])("reads %j as a real value", (v) => {
    expect(isPlaceholderCell(v)).toBe(false);
  });
});
