import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  normalizeRemovalReason,
  parseRejectedLine,
  REMOVAL_REASON_MAX,
} from "@/lib/stop-removal";
import { isDeliveryDone } from "@/lib/trip-data";

describe("removal reasons", () => {
  it("are required, tidied and capped", () => {
    expect(normalizeRemovalReason("  Wrong   item\nsent ")).toBe("Wrong item sent");
    expect(normalizeRemovalReason("   ")).toBeNull();
    expect(normalizeRemovalReason(undefined)).toBeNull();
    expect(normalizeRemovalReason(42)).toBeNull();
    expect(normalizeRemovalReason("x".repeat(900))!.length).toBe(REMOVAL_REASON_MAX);
  });
});

describe("rejected lines", () => {
  it("need a description and a reason", () => {
    expect(parseRejectedLine({ reason: "Damaged" }).ok).toBe(false);
    expect(parseRejectedLine({ description: "Widget" }).ok).toBe(false);
    expect(parseRejectedLine(null).ok).toBe(false);
  });

  it("take an optional whole-number quantity", () => {
    const blank = parseRejectedLine({ description: "Widget", reason: "Damaged", quantity: "" });
    expect(blank).toEqual({ ok: true, line: { description: "Widget", quantity: null, reason: "Damaged" } });

    const typed = parseRejectedLine({ description: "Widget", reason: "Damaged", quantity: " 3 " });
    expect(typed.ok && typed.line.quantity).toBe(3);

    for (const bad of [0, -1, 1.5, "two", 1_000_000]) {
      expect(parseRejectedLine({ description: "Widget", reason: "Damaged", quantity: bad }).ok).toBe(false);
    }
  });
});

describe("isDeliveryDone", () => {
  it("treats a stop with no invoice as having nothing to sign", () => {
    // A collection-only stop, or one whose invoice was taken off the run. These
    // used to block completion forever because nothing ever signs them.
    expect(isDeliveryDone({ invoiceNumber: "", status: "PENDING" })).toBe(true);
    expect(isDeliveryDone({ invoiceNumber: "INV-1", status: "PENDING" })).toBe(false);
    expect(isDeliveryDone({ invoiceNumber: "INV-1", status: "IN_PROGRESS" })).toBe(false);
    expect(isDeliveryDone({ invoiceNumber: "INV-1", status: "SIGNED" })).toBe(true);
  });
});

describe("the signed PDF of a partial delivery", () => {
  // A 1×1 transparent PNG — the shape of a signature, without the drawing.
  const PNG = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64"
    )
  );

  const invoice = async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    return Buffer.from(await doc.save());
  };

  it("appends an exceptions page only when lines were refused", async () => {
    const { vi } = await import("vitest");
    vi.doMock("@/lib/config", () => ({
      readConfig: async () => ({
        signaturePosition: { page: "last", xPercent: 60, yPercent: 10, widthPercent: 25 },
      }),
    }));
    const { embedSignatureOnPdf } = await import("@/lib/invoices");

    const full = await PDFDocument.load(await embedSignatureOnPdf("t", await invoice(), PNG, "Sam"));
    expect(full.getPageCount()).toBe(1);

    const partial = await PDFDocument.load(
      await embedSignatureOnPdf("t", await invoice(), PNG, "Sam", [
        // Characters Helvetica cannot encode must not fail a signature.
        { description: "Widget 40mm ✓", quantity: 2, reason: "Wrong size 😞" },
        { description: "x ".repeat(200), quantity: null, reason: "Damaged" },
      ])
    );
    expect(partial.getPageCount()).toBe(2);
    vi.doUnmock("@/lib/config");
  });
});
