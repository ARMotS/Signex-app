import { describe, it, expect } from "vitest";
import { chainBalance, chainStatus, type ChainCollectionFacts, type ChainFacts } from "@/lib/invoice-chain";

const cr = (over: Partial<ChainCollectionFacts> = {}): ChainCollectionFacts => ({
  id: "c1",
  type: "CREDIT_RETURN",
  status: "COLLECTED",
  creditReview: "APPROVED",
  collectedQty: 2,
  lines: [{ id: "l1", qtyCollected: 2, type: "CREDIT_RETURN" }],
  ...over,
});

const facts = (over: Partial<ChainFacts> = {}): ChainFacts => ({
  delivered: true,
  collections: [],
  creditNoteStatuses: [],
  creditedByLine: new Map(),
  creditedCollectionIds: new Set(),
  ...over,
});

describe("chainStatus", () => {
  it("is Delivered, or Not delivered, with nothing coming back", () => {
    expect(chainStatus(facts())).toBe("DELIVERED");
    expect(chainStatus(facts({ delivered: false }))).toBe("NOT_DELIVERED");
  });

  it("is Collection pending while the driver has not been", () => {
    expect(chainStatus(facts({ collections: [cr({ status: "PENDING", creditReview: null })] }))).toBe("COLLECTION_PENDING");
  });

  it("follows what came back through credit", () => {
    const back = [cr()];
    expect(chainStatus(facts({ collections: back }))).toBe("AWAITING_CREDIT");
    expect(chainStatus(facts({ collections: back, creditedByLine: new Map([["l1", 1]]) }))).toBe("PARTIALLY_CREDITED");
    expect(chainStatus(facts({ collections: back, creditedByLine: new Map([["l1", 2]]) }))).toBe("FULLY_CREDITED");
  });

  it("credits a collection with no sheet lines all or nothing", () => {
    const back = [cr({ lines: [] })];
    expect(chainStatus(facts({ collections: back }))).toBe("AWAITING_CREDIT");
    expect(chainStatus(facts({ collections: back, creditedCollectionIds: new Set(["c1"]) }))).toBe("FULLY_CREDITED");
  });

  it("is an Exception for a rejected or failed collection, a note needing review, or over-crediting", () => {
    expect(chainStatus(facts({ collections: [cr({ creditReview: "REJECTED" })] }))).toBe("EXCEPTION");
    expect(chainStatus(facts({ collections: [cr({ status: "REFUSED", creditReview: null })] }))).toBe("EXCEPTION");
    expect(chainStatus(facts({ collections: [cr()], creditNoteStatuses: ["NEEDS_REVIEW"] }))).toBe("EXCEPTION");
    expect(chainStatus(facts({ collections: [cr()], creditedByLine: new Map([["l1", 3]]) }))).toBe("EXCEPTION");
  });

  it("ignores uplifts", () => {
    expect(chainStatus(facts({ collections: [cr({ type: "NON_CREDIT_UPLIFT", status: "PENDING" })] }))).toBe("DELIVERED");
  });
});

describe("chainBalance", () => {
  it("sums collected and credited per item, and what is still outstanding", () => {
    const rows = chainBalance(
      [
        { id: "a", itemCode: "618ABG", description: "BATTERY", qtyCollected: 2, type: "CREDIT_RETURN" },
        { id: "b", itemCode: "618ABG", description: "BATTERY", qtyCollected: 1, type: "CREDIT_RETURN" },
        { id: "c", itemCode: "RELAY", description: "12V RELAY", qtyCollected: 1, type: "CREDIT_RETURN" },
        { id: "d", itemCode: "CRATE", description: "Plastic crate", qtyCollected: 4, type: "NON_CREDIT_UPLIFT" },
      ],
      new Map([["a", 2], ["c", 1]])
    );
    expect(rows).toEqual([
      { item: "618ABG", description: "BATTERY", collected: 3, credited: 2, outstanding: 1 },
      { item: "RELAY", description: "12V RELAY", collected: 1, credited: 1, outstanding: 0 },
    ]);
  });
});
