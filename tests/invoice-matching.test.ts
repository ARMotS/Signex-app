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
  normalizeInvoiceNumber,
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

  it("ignores the trailing -N for assignment", () => {
    expect(normalizeInvoiceNumber("IV-365-4")).toBe("365");
    expect(normalizeInvoiceNumber("INV-365-4.pdf")).toBe("365");
    expect(normalizeInvoiceNumber("IV-633291")).toBe("633291");
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
    expect(normalizeInvoiceNumber("SIGMA-12")).toBe("SIGMA12");
  });
});

describe("placeholder cells", () => {
  it.each(["0", "00", "-", "--", "–", "N/A", "nil", " 0 "])("reads %j as empty", (v) => {
    expect(isPlaceholderCell(v)).toBe(true);
  });

  it.each(["10", "INV-0", "COL-118", "0365"])("reads %j as a real value", (v) => {
    expect(isPlaceholderCell(v)).toBe(false);
  });
});
