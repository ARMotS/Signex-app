/**
 * The point of uploading a missing invoice is that the trip sheet then matches
 * it. That only holds if the name the file is stored under normalizes to the
 * same thing as the number written on the sheet — so the two halves are
 * asserted against each other here, not in isolation.
 *
 * The deploy gate is tested alongside it: it is what stands between a stale
 * browser tab and a driver sent out with no paperwork.
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeInvoiceFilename,
  invoiceFilenameForNumber,
  looksLikePdf,
} from "@/lib/invoices";
import { collectMissingInvoices, normalizeInvoiceNumber } from "@/lib/trip-parser";
import type { MatchResult } from "@/lib/trip-parser";

describe("sanitizeInvoiceFilename", () => {
  it("keeps an ordinary name and enforces the .pdf suffix", () => {
    expect(sanitizeInvoiceFilename("INV-2041.pdf")).toBe("INV-2041.pdf");
    expect(sanitizeInvoiceFilename("INV-2041")).toBe("INV-2041.pdf");
    expect(sanitizeInvoiceFilename("inv-2041.PDF")).toBe("inv-2041.pdf");
  });

  it("strips any directory component rather than trusting it", () => {
    expect(sanitizeInvoiceFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeInvoiceFilename("C:\\Windows\\system32\\evil.pdf")).toBe("evil.pdf");
    expect(sanitizeInvoiceFilename("signed/INV-1.pdf")).toBe("INV-1.pdf");
  });

  it("refuses names that leave nothing usable behind", () => {
    expect(sanitizeInvoiceFilename("")).toBeNull();
    expect(sanitizeInvoiceFilename("   ")).toBeNull();
    expect(sanitizeInvoiceFilename("..")).toBeNull();
    expect(sanitizeInvoiceFilename(".pdf")).toBeNull();
    expect(sanitizeInvoiceFilename("/")).toBeNull();
  });

  it("removes control characters and characters Windows rejects", () => {
    expect(sanitizeInvoiceFilename("INV\u00002041.pdf")).toBe("INV2041.pdf");
    expect(sanitizeInvoiceFilename('INV:20"41?.pdf')).toBe("INV2041.pdf");
  });
});

describe("invoiceFilenameForNumber", () => {
  // The whole feature rests on this: a PDF saved under the invoice number as
  // written on the sheet has to come back as a match on the very next parse.
  const numbers = [
    "INV-2041",
    "Invoice # 001",
    "827323",
    "IV-365-4",
    "inv 42",
    " INV-7 ",
  ];

  it.each(numbers)("stores %s under a name that matches it back", (raw) => {
    const filename = invoiceFilenameForNumber(raw);
    expect(filename).not.toBeNull();

    // listInvoiceFiles derives an invoice number from the filename stem, which
    // is what the parser then normalizes.
    const derived = filename!.replace(/\.pdf$/i, "").toUpperCase();
    expect(normalizeInvoiceNumber(derived)).toBe(normalizeInvoiceNumber(raw));
  });

  it("rejects an invoice number that sanitizes to nothing", () => {
    expect(invoiceFilenameForNumber("///")).toBeNull();
  });
});

describe("looksLikePdf", () => {
  it("accepts a PDF header, including one behind a short preamble", () => {
    expect(looksLikePdf(Buffer.from("%PDF-1.7\n..."))).toBe(true);
    expect(looksLikePdf(Buffer.concat([Buffer.alloc(64), Buffer.from("%PDF-1.4")]))).toBe(true);
  });

  it("rejects a renamed non-PDF", () => {
    expect(looksLikePdf(Buffer.from("PK\u0003\u0004 this is a zip"))).toBe(false);
    expect(looksLikePdf(Buffer.alloc(0))).toBe(false);
  });

  it("ignores a header buried past the first block", () => {
    const buried = Buffer.concat([Buffer.alloc(2048), Buffer.from("%PDF-1.4")]);
    expect(looksLikePdf(buried)).toBe(false);
  });
});

// ─── Deploy gate ──────────────────────────────────────────────────────────

function stop(invoiceNumber: string, invoiceFile?: string) {
  return {
    id: `stop-${invoiceNumber}`,
    stopNumber: 1,
    invoiceNumber,
    customerName: `Customer ${invoiceNumber}`,
    address: "",
    nop: 1,
    invoiceFile,
    status: "PENDING" as const,
  };
}

function driverResult(overrides: Partial<MatchResult> = {}): MatchResult {
  return {
    driverId: "driver-1",
    driverName: "Sipho",
    regNo: "CA 123-456",
    stops: [],
    unmatchedInvoices: [],
    unmatchedCollections: [],
    ...overrides,
  };
}

describe("collectMissingInvoices", () => {
  it("reports only stops with no PDF", () => {
    const results = [
      driverResult({ stops: [stop("A-1", "A-1.pdf"), stop("A-2")] }),
    ];

    const missing = collectMissingInvoices(results, new Set());
    expect(missing.map((m) => m.invoiceNumber)).toEqual(["A-2"]);
    expect(missing[0]).toMatchObject({
      customerName: "Customer A-2",
      driverName: "Sipho",
      stopId: "stop-A-2",
    });
  });

  it("treats a skipped stop as resolved — it is not being deployed", () => {
    const results = [driverResult({ stops: [stop("A-2")] })];
    expect(collectMissingInvoices(results, new Set(["A-2"]))).toEqual([]);
  });

  it("matches the skip list case-insensitively, as the routes send it", () => {
    const results = [driverResult({ stops: [stop("inv-9")] })];
    expect(collectMissingInvoices(results, new Set(["INV-9"]))).toEqual([]);
  });

  it("ignores unassigned rows until a driver is chosen for them", () => {
    const results = [
      driverResult({
        driverId: "__unassigned__",
        driverName: "Unassigned",
        stops: [stop("U-1")],
      }),
    ];

    expect(collectMissingInvoices(results, new Set())).toEqual([]);
    expect(
      collectMissingInvoices(results, new Set(), { includeUnassigned: true })
        .map((m) => m.invoiceNumber)
    ).toEqual(["U-1"]);
  });

  it("returns nothing when every stop has its PDF", () => {
    const results = [
      driverResult({ stops: [stop("A-1", "A-1.pdf"), stop("A-2", "A-2.pdf")] }),
    ];
    expect(collectMissingInvoices(results, new Set())).toEqual([]);
  });
});
