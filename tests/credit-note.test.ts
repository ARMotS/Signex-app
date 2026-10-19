import { describe, it, expect } from "vitest";
import { extractPageItems } from "@/lib/invoice-header";
import {
  assessCreditNote,
  checkCreditFigures,
  matchCreditLines,
  parseAmount,
  readCreditNoteFromPages,
  type CollectedLine,
  type CreditContext,
  type ParsedCreditNote,
} from "@/lib/credit-note";
import { creditNotePdf, CR_407712_LINES, type CreditFixtureLine } from "./helpers/credit-note-fixture";

const read = async (pdf: Buffer) => readCreditNoteFromPages(await extractPageItems(pdf, 10));

const line = (n: number, over: Partial<CreditFixtureLine> = {}): CreditFixtureLine => ({
  productCode: `P${100 + n}`,
  shortName: `ITEM ${n}`,
  bin: `B${n}`,
  description: `PART NUMBER ${n} 12V`,
  qty: 1,
  unitPrice: 10 * n,
  disc: 0,
  nett: 10 * n,
  ...over,
});

describe("reading the client's credit note", () => {
  it("reads CR-407712's header, its one line and its totals", async () => {
    const note = await read(await creditNotePdf());

    expect(note).toMatchObject({
      creditNo: "407712",
      invoiceNo: "384281",
      // The "Invoice date" box, not the Order date (19/07/2024) beside it.
      creditDate: "2026-10-16",
      accountNo: "C007H014",
      deliverToName: "HELDERBERG MOTOR SPARES",
      billToName: "HELDERBERG MOTOR SPARES",
      subtotal: 720,
      vatAmount: 108,
      total: 828,
    });
    expect(note.lines).toEqual([
      {
        lineNo: 1,
        productCode: "618ABG",
        shortName: "BATTERY",
        bin: "FLOOR",
        description: "BATT BM-618B41LB1 41AH 360CCA",
        qty: 1,
        unitPrice: 720,
        discountPct: 0,
        nett: 720,
      },
    ]);
    expect(checkCreditFigures(note, 0.15)).toEqual([]);
  });

  it("never reads the Other / Brand / Uom row as a line", async () => {
    const note = await read(await creditNotePdf({ pages: [[line(1), line(2), line(3)]] }));
    expect(note.lines.map((l) => l.productCode)).toEqual(["P101", "P102", "P103"]);
    for (const l of note.lines) {
      expect(l.description).not.toMatch(/UNITECH|EACH|Brand|Other/);
      expect(l.shortName).not.toMatch(/,,/);
    }
  });

  it("reads lines on every page, with discounts and quantities over one", async () => {
    const discounted = line(4, { qty: 10, unitPrice: 4.05, disc: 30, nett: 28.3 });
    const pages = [
      [line(1), line(2), line(3)],
      [discounted, line(5, { qty: 3, unitPrice: 12.5, nett: 37.5 })],
    ];
    const note = await read(await creditNotePdf({ pages }));

    expect(note.lines).toHaveLength(5);
    expect(note.lines.map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5]);
    expect(note.lines[3]).toMatchObject({ productCode: "P104", qty: 10, unitPrice: 4.05, discountPct: 30, nett: 28.3 });
    expect(note.subtotal).toBe(10 + 20 + 30 + 28.3 + 37.5);
    expect(checkCreditFigures(note, 0.15)).toEqual([]);
  });

  it("does not mistake an invoice reference for the credit number", async () => {
    const note = await read(await creditNotePdf({ creditNo: "CN-5001", invoiceNo: "IV-384281" }));
    expect(note.creditNo).toBe("CN-5001");
    expect(note.invoiceNo).toBe("IV-384281");
  });

  it("leaves the invoice null when the note does not print one", async () => {
    expect((await read(await creditNotePdf({ invoiceNo: null }))).invoiceNo).toBeNull();
  });
});

describe("parseAmount", () => {
  it.each([
    ["720.00", 720],
    ["1,234.56", 1234.56],
    ["1 234.56", 1234.56],
    ["R 828.00", 828],
    ["720,00", 720],
    ["720.00-", -720],
    ["-15.5", -15.5],
    ["0", 0],
  ])("%s → %s", (raw, value) => expect(parseAmount(raw)).toBe(value));

  it.each(["10.200", "C007H014", "16/10/2026", "", "1.2.3"])("%s is not an amount", (raw) =>
    expect(parseAmount(raw)).toBeNull()
  );
});

// ─── The note's own figures ────────────────────────────────────────────

const parsed = (over: Partial<ParsedCreditNote> = {}): ParsedCreditNote => ({
  creditNo: "407712",
  invoiceNo: "384281",
  creditDate: "2026-10-16",
  accountNo: "C007H014",
  deliverToName: "HELDERBERG MOTOR SPARES",
  billToName: "HELDERBERG MOTOR SPARES",
  lines: [
    {
      lineNo: 1,
      productCode: "618ABG",
      shortName: "BATTERY",
      bin: "FLOOR",
      description: "BATT BM-618B41LB1 41AH 360CCA",
      qty: 1,
      unitPrice: 720,
      discountPct: 0,
      nett: 720,
    },
  ],
  subtotal: 720,
  vatAmount: 108,
  total: 828,
  ...over,
});

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("checkCreditFigures", () => {
  it("flags lines that do not add up to the sub total — a line was missed", async () => {
    const note = await read(await creditNotePdf({ pages: [[line(1), line(2)]], subtotal: 60, vat: 9, total: 69 }));
    const issues = checkCreditFigures(note, 0.15);
    expect(codes(issues)).toEqual(["LINES_TOTAL"]);
    expect(issues[0].level).toBe("review");
  });

  it("flags VAT that is not the configured rate, and a total that is not sub total plus VAT", () => {
    expect(codes(checkCreditFigures(parsed({ vatAmount: 100.8, total: 820.8 }), 0.15))).toEqual(["VAT_MISMATCH"]);
    expect(codes(checkCreditFigures(parsed({ vatAmount: 100.8, total: 820.8 }), 0.14))).toEqual([]);
    expect(codes(checkCreditFigures(parsed({ total: 900 }), 0.15))).toEqual(["TOTAL_MISMATCH"]);
  });

  it("accepts the per-unit rounding after a discount, and flags a line that is simply wrong", () => {
    const discounted = { lineNo: 1, productCode: "F", shortName: null, bin: null, description: "FUSE", qty: 10, unitPrice: 4.05, discountPct: 30, nett: 28.3 };
    expect(codes(checkCreditFigures(parsed({ lines: [discounted], subtotal: 28.3, vatAmount: 4.25, total: 32.55 }), 0.15))).toEqual([]);
    expect(
      codes(checkCreditFigures(parsed({ lines: [{ ...discounted, nett: 30 }], subtotal: 30, vatAmount: 4.5, total: 34.5 }), 0.15))
    ).toEqual(["LINE_AMOUNT"]);
  });

  it("asks for review when no totals could be read", () => {
    expect(codes(checkCreditFigures(parsed({ subtotal: null, vatAmount: null, total: null }), 0.15))).toEqual(["TOTALS_UNREAD"]);
  });
});

// ─── Matching ────────────────────────────────────────────────────────────

const collected = (over: Partial<CollectedLine> = {}): CollectedLine => ({
  id: "cl-1",
  collectionId: "c-1",
  collectionNo: "1797",
  itemCode: "618ABG",
  shortName: "BATTERY",
  description: "BATT BM-618B41LB1 41AH 360CCA",
  qtyCollected: 1,
  type: "CREDIT_RETURN",
  ...over,
});

const creditLine = (over: Partial<{ lineNo: number; productCode: string | null; shortName: string | null; description: string; qty: number }> = {}) => ({
  lineNo: 1,
  productCode: "618ABG",
  shortName: "BATTERY",
  description: "BATT BM-618B41LB1 41AH 360CCA",
  qty: 1,
  ...over,
});

describe("matchCreditLines", () => {
  it("matches by product code", () => {
    const [m] = matchCreditLines([creditLine()], [collected()]);
    expect(m).toMatchObject({ status: "MATCHED", uncoveredQty: 0, allocations: [{ collectionLineId: "cl-1", collectionNo: "1797", qty: 1 }] });
  });

  it("falls back to the description when the codes differ", () => {
    const [m] = matchCreditLines([creditLine({ productCode: "X-1" })], [collected({ itemCode: "OTHER" })]);
    expect(m.status).toBe("MATCHED");
  });

  it("credits more than came back → OVER; something never collected → NOT_COLLECTED", () => {
    const [over, none] = matchCreditLines(
      [creditLine({ qty: 3 }), creditLine({ lineNo: 2, productCode: "RELAY", description: "12V 5PIN RELAY" })],
      [collected({ qtyCollected: 2 })]
    );
    expect(over).toMatchObject({ status: "OVER", uncoveredQty: 1 });
    expect(none).toMatchObject({ status: "NOT_COLLECTED", allocations: [] });
  });

  it("never credits one return twice: already credited elsewhere, or by an earlier line", () => {
    expect(matchCreditLines([creditLine()], [collected()], new Map([["cl-1", 1]]))[0].status).toBe("OVER");
    const [first, second] = matchCreditLines([creditLine(), creditLine({ lineNo: 2 })], [collected()]);
    expect(first.status).toBe("MATCHED");
    expect(second.status).toBe("OVER");
  });

  it("spreads one credit line over the same item on two collections", () => {
    const [m] = matchCreditLines(
      [creditLine({ qty: 3 })],
      [collected({ qtyCollected: 1 }), collected({ id: "cl-2", collectionId: "c-2", collectionNo: "1800", qtyCollected: 2 })]
    );
    expect(m.status).toBe("MATCHED");
    expect(m.allocations.map((a) => [a.collectionNo, a.qty])).toEqual([["1797", 1], ["1800", 2]]);
  });

  it("never credits an uplift", () => {
    expect(matchCreditLines([creditLine()], [collected({ type: "NON_CREDIT_UPLIFT" })])[0].status).toBe("NOT_COLLECTED");
  });
});

// ─── Assessment ──────────────────────────────────────────────────────────

const context = (over: Partial<CreditContext> = {}): CreditContext => ({
  vatRate: 0.15,
  invoice: { invoiceNo: "384281", customerName: "HELDERBERG MOTOR SPARES" },
  collections: [{ id: "c-1", collectionNo: "1797", hasLines: true }],
  pendingCollectionNos: [],
  collectedLines: [collected()],
  alreadyCredited: new Map(),
  ...over,
});

describe("assessCreditNote", () => {
  it("a note matching what came back is RECEIVED with nothing to look at", () => {
    const result = assessCreditNote(parsed(), context(), "TEXT");
    expect(result).toMatchObject({ status: "RECEIVED", issues: [] });
    expect(result.matches[0].status).toBe("MATCHED");
  });

  it("an invoice Signex has never seen needs review", () => {
    const result = assessCreditNote(parsed(), context({ invoice: null, collections: [], collectedLines: [] }), "TEXT");
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(codes(result.issues)).toEqual(["INVOICE_UNKNOWN"]);
  });

  it("says when the collection has not been collected yet, or there is none", () => {
    const pending = assessCreditNote(parsed(), context({ collections: [], collectedLines: [], pendingCollectionNos: ["1797"] }), "TEXT");
    expect(codes(pending.issues)).toEqual(["COLLECTION_PENDING"]);
    const none = assessCreditNote(parsed(), context({ collections: [], collectedLines: [] }), "TEXT");
    expect(codes(none.issues)).toEqual(["NO_COLLECTION"]);
  });

  it("crediting more than came back, or something not collected, needs review", () => {
    const over = assessCreditNote(parsed(), context({ collectedLines: [collected({ qtyCollected: 0 })] }), "TEXT");
    expect(codes(over.issues)).toContain("MORE_THAN_COLLECTED");
    const other = assessCreditNote(parsed(), context({ collectedLines: [collected({ itemCode: "RELAY", shortName: "RELAY", description: "12V RELAY" })] }), "TEXT");
    expect(codes(other.issues)).toEqual(expect.arrayContaining(["NOT_COLLECTED", "NOT_ALL_CREDITED"]));
    expect(other.status).toBe("NEEDS_REVIEW");
  });

  it("a partial credit is a warning, not a review", () => {
    const result = assessCreditNote(parsed(), context({ collectedLines: [collected({ qtyCollected: 2 })] }), "TEXT");
    expect(result.status).toBe("RECEIVED");
    expect(codes(result.issues)).toEqual(["NOT_ALL_CREDITED"]);
  });

  it("a collection recorded without sheet lines is a warning, and its quantities are not judged", () => {
    const result = assessCreditNote(parsed(), context({ collections: [{ id: "c-1", collectionNo: "1797", hasLines: false }], collectedLines: [] }), "TEXT");
    expect(result.status).toBe("RECEIVED");
    expect(codes(result.issues)).toEqual(["NO_SHEET_LINES"]);
  });

  it("warns on another customer's name, and on a scan", () => {
    const result = assessCreditNote(
      parsed({ deliverToName: "SOMEONE ELSE", billToName: "SOMEONE ELSE" }),
      context(),
      "AI"
    );
    expect(result.status).toBe("RECEIVED");
    expect(codes(result.issues)).toEqual(["CUSTOMER_MISMATCH", "READ_FROM_SCAN"]);
  });
});

describe("the fixture", () => {
  it("is the one-line note", () => expect(CR_407712_LINES).toHaveLength(1));
});

describe("the office's decision on the collection", () => {
  it("a note against a collection the office rejected needs review, and says why", () => {
    const result = assessCreditNote(
      parsed(),
      context({ collections: [], collectedLines: [], rejectedCollections: [{ collectionNo: "1797", reason: "Goods damaged by the customer" }] }),
      "TEXT"
    );
    expect(result.status).toBe("NEEDS_REVIEW");
    expect(codes(result.issues)).toEqual(["COLLECTION_REJECTED"]);
    expect(result.issues[0].message).toContain("Goods damaged by the customer");
  });

  it("a collection not yet approved is a warning only", () => {
    const result = assessCreditNote(parsed(), context({ unapprovedCollectionNos: ["1797"] }), "TEXT");
    expect(result.status).toBe("RECEIVED");
    expect(codes(result.issues)).toEqual(["COLLECTION_NOT_APPROVED"]);
  });
});
