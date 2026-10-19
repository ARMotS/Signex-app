/**
 * Confirm-by-exception: the driver confirms the office's sheet in one tap,
 * records only what differs, or says why it failed. The same rules run on the
 * phone (to enable Confirm) and on the server (to record it).
 */

import { describe, it, expect } from "vitest";
import {
  collectionDeclaration,
  DEFAULT_COLLECTION_DECLARATION,
  resolveConfirmation,
  type ListedLine,
} from "@/lib/collection-confirm";
import { buildSignedCollectionPdf } from "@/lib/collections";
import { extractPageItems } from "@/lib/invoice-header";

const SHEET: ListedLine[] = [
  { lineNo: 1, description: "0.75MM 7COR CABLE P/30MR", qtyListed: 1 },
  { lineNo: 2, description: "12V HYBRID REG (MONARK)", qtyListed: 1 },
  { lineNo: 3, description: "12V 5PIN 30A BOSCH RELAY", qtyListed: 2 },
];

describe("Collected as listed", () => {
  it("collects every line at its listed count and needs a signature", () => {
    const r = resolveConfirmation(SHEET, { mode: "AS_LISTED" });
    expect(r).toMatchObject({
      ok: true,
      status: "COLLECTED",
      hasVariance: false,
      needsSignature: true,
      collectedItems: 4,
      listedItems: 4,
      exceptionReason: null,
    });
    if (r.ok) expect(r.lineUpdates.map((u) => u.qtyCollected)).toEqual([1, 1, 2]);
  });
});

describe("Not as listed", () => {
  it("is PARTIAL when fewer came back, with the difference spelled out", () => {
    const r = resolveConfirmation(SHEET, {
      mode: "NOT_AS_LISTED",
      lines: [{ lineNo: 3, qtyCollected: 1, diffReason: "DAMAGED", diffNote: "one cracked" }],
    });
    expect(r).toMatchObject({ ok: true, status: "PARTIAL", hasVariance: true, collectedItems: 3 });
    if (r.ok) {
      // Lines left out came back as listed.
      expect(r.lineUpdates.map((u) => u.qtyCollected)).toEqual([1, 1, 1]);
      expect(r.exceptionReason).toBe("12V 5PIN 30A BOSCH RELAY: 1 of 2 (Damaged — one cracked)");
    }
  });

  it("is COLLECTED, still flagged, when everything came back but something was wrong", () => {
    const r = resolveConfirmation(SHEET, {
      mode: "NOT_AS_LISTED",
      lines: [{ lineNo: 2, qtyCollected: 1, diffReason: "DAMAGED" }],
    });
    expect(r).toMatchObject({ ok: true, status: "COLLECTED", hasVariance: true });
  });

  it("records extras without letting them cover a short line", () => {
    const r = resolveConfirmation(SHEET, {
      mode: "NOT_AS_LISTED",
      lines: [{ lineNo: 1, qtyCollected: 0, diffReason: "CUSTOMER_KEPT" }],
      extras: [{ description: "  Plastic crate ", qty: 2 }],
    });
    expect(r).toMatchObject({ ok: true, status: "PARTIAL", collectedItems: 5 });
    if (r.ok) expect(r.extras).toEqual([{ description: "Plastic crate", qty: 2 }]);
  });

  it.each([
    [{ lines: [{ lineNo: 3, qtyCollected: 1 }] }, "say why fewer came back"],
    [{ lines: [{ lineNo: 3, qtyCollected: 3 }] }, "from 0 to 2"],
    [{ lines: [{ lineNo: 3, qtyCollected: -1, diffReason: "SHORT" }] }, "from 0 to 2"],
    [{ lines: [{ lineNo: 9, qtyCollected: 0, diffReason: "SHORT" }] }, "not on this collection's sheet"],
    [{ lines: [{ lineNo: 1, qtyCollected: 0, diffReason: "OTHER" }] }, "describe what happened"],
    [{ lines: [{ lineNo: 1, qtyCollected: 0, diffReason: "LOST" }] }, "not recognised"],
    [{}, "use Collected as listed"],
    [{ extras: [{ description: "", qty: 1 }] }, "Describe each extra item"],
    [{ extras: [{ description: "Crate", qty: 0 }] }, "1 or more"],
  ])("refuses %j", (input, error) => {
    const r = resolveConfirmation(SHEET, { mode: "NOT_AS_LISTED", ...input });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toContain(error.toLowerCase());
  });

  it("sends a nothing-came-back confirmation to Collection failed", () => {
    const r = resolveConfirmation(SHEET, {
      mode: "NOT_AS_LISTED",
      lines: SHEET.map((l) => ({ lineNo: l.lineNo, qtyCollected: 0, diffReason: "NOT_AVAILABLE" })),
    });
    expect(r).toEqual({ ok: false, error: "Nothing came back — use Collection failed" });
  });
});

describe("Collection failed", () => {
  it("a refusal is REFUSED; anything else is NOT_AVAILABLE; neither is signed", () => {
    const refused = resolveConfirmation(SHEET, { mode: "FAILED", failReason: "CUSTOMER_REFUSED" });
    expect(refused).toMatchObject({ ok: true, status: "REFUSED", needsSignature: false, exceptionReason: "Customer refused" });

    const notReady = resolveConfirmation(SHEET, { mode: "FAILED", failReason: "CUSTOMER_NOT_READY", failNote: "come back Friday" });
    expect(notReady).toMatchObject({
      ok: true,
      status: "NOT_AVAILABLE",
      exceptionReason: "Customer not ready: come back Friday",
      collectedItems: 0,
    });
  });

  it("needs a reason, and a description for Other", () => {
    expect(resolveConfirmation(SHEET, { mode: "FAILED" }).ok).toBe(false);
    expect(resolveConfirmation(SHEET, { mode: "FAILED", failReason: "OTHER" }).ok).toBe(false);
    expect(resolveConfirmation(SHEET, { mode: "FAILED", failReason: "OTHER", failNote: "gate locked" }).ok).toBe(true);
  });
});

describe("the declaration", () => {
  it("fills in the company, falling back to the standard wording", () => {
    expect(collectionDeclaration("", "Electro City")).toBe(
      DEFAULT_COLLECTION_DECLARATION.replace("{companyName}", "Electro City")
    );
    expect(collectionDeclaration("Received by {companyName}.", "Electro City")).toBe("Received by Electro City.");
  });
});

describe("the signed receipt", () => {
  const text = async (pdf: Buffer) =>
    (await extractPageItems(pdf)).map((page) => page.map((i) => i.str).join(" ").replace(/\s+/g, " "));

  it("lists the sheet against what came back, spells out the variance, and carries the declaration", async () => {
    const pdf = await buildSignedCollectionPdf(null, {
      collectionNo: "001797",
      type: "CREDIT_RETURN",
      status: "PARTIAL",
      customerName: "VISA AUTO ELECTRICAL",
      collectedAt: new Date("2026-10-18T09:00:00Z"),
      signedByName: "J Smith",
      declaration: collectionDeclaration("", "Electro City"),
      lines: [
        { itemCode: "REG", description: "12V HYBRID REG (MONARK)", qtyListed: 1, qtyCollected: 1, diffReason: null, diffNote: null, isExtra: false },
        { itemCode: "RELAY", description: "12V 5PIN 30A BOSCH RELAY", qtyListed: 2, qtyCollected: 1, diffReason: "Damaged", diffNote: null, isExtra: false },
        { itemCode: null, description: "Plastic crate", qtyListed: 0, qtyCollected: 2, diffReason: null, diffNote: null, isExtra: true },
      ],
    });
    const [page] = await text(pdf);
    expect(page).toContain("Listed 2 · Collected 1 · Damaged");
    expect(page).toContain("Extra — not on the sheet · Collected 2");
    expect(page).toContain("4 item(s) collected of 3 listed");
    expect(page).toContain("approval by Electro City");
  });

  it("carries a long sheet onto further pages instead of off the bottom", async () => {
    const lines = Array.from({ length: 45 }, (_, i) => ({
      itemCode: `IT${i}`,
      description: `ITEM NUMBER ${i}`,
      qtyListed: 1,
      qtyCollected: 1,
      diffReason: null,
      diffNote: null,
      isExtra: false,
    }));
    const pdf = await buildSignedCollectionPdf(null, {
      collectionNo: "1",
      type: "CREDIT_RETURN",
      status: "COLLECTED",
      customerName: "X",
      collectedAt: new Date(),
      lines,
    });
    const pages = await text(pdf);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join(" ")).toContain("ITEM NUMBER 44");
  });

  it("still files when a driver types something the font cannot draw", async () => {
    const pdf = await buildSignedCollectionPdf(null, {
      collectionNo: "1",
      type: "CREDIT_RETURN",
      status: "PARTIAL",
      customerName: "X",
      collectedAt: new Date(),
      signedByName: "Thandi 👍",
      exceptionReason: "Crate 📦 cracked",
      lines: [
        { itemCode: "REG", description: "REG", qtyListed: 2, qtyCollected: 1, diffReason: "Damaged", diffNote: "lid 🔧 broken", isExtra: false },
      ],
    });
    const [page] = await text(pdf);
    expect(page).toContain("Damaged — lid broken");
    expect(page).toContain("Signed by Thandi");
  });

  it("prints no declaration where nothing changed hands", async () => {
    const pdf = await buildSignedCollectionPdf(null, {
      collectionNo: "1",
      type: "CREDIT_RETURN",
      status: "REFUSED",
      customerName: "X",
      collectedAt: new Date(),
      declaration: "DECLARATION TEXT",
    });
    expect((await text(pdf))[0]).not.toContain("DECLARATION TEXT");
  });
});

describe("the office's decision on a credit return", () => {
  const cr = { type: "CREDIT_RETURN", originalInvoiceNo: "130522", status: "COLLECTED" };

  it("is needed for a CR that came back, collected or partly", async () => {
    const { creditReviewRequired, awaitingCreditReview } = await import("@/lib/collection-confirm");
    expect(creditReviewRequired(cr)).toBe(true);
    expect(creditReviewRequired({ ...cr, status: "PARTIAL" })).toBe(true);
    expect(awaitingCreditReview(cr)).toBe(true);
    expect(awaitingCreditReview({ ...cr, creditReview: "APPROVED" })).toBe(false);
    expect(awaitingCreditReview({ ...cr, creditReview: "REJECTED" })).toBe(false);
  });

  it("is not needed for CO, an uplift, a failed collection or one still pending", async () => {
    const { creditReviewRequired } = await import("@/lib/collection-confirm");
    expect(creditReviewRequired({ ...cr, originalInvoiceNo: null })).toBe(false);
    expect(creditReviewRequired({ ...cr, type: "NON_CREDIT_UPLIFT" })).toBe(false);
    expect(creditReviewRequired({ ...cr, status: "NOT_AVAILABLE" })).toBe(false);
    expect(creditReviewRequired({ ...cr, status: "REFUSED" })).toBe(false);
    expect(creditReviewRequired({ ...cr, status: "PENDING" })).toBe(false);
  });
});
