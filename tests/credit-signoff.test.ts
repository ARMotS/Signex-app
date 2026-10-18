import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { extractPageItems } from "@/lib/invoice-header";
import {
  appendCreditReference,
  buildSignedCreditNotePdf,
  signedCreditFilename,
  validateSignOff,
  type SignOffPageData,
} from "@/lib/credit-signoff-pdf";
import { creditNotePdf } from "./helpers/credit-note-fixture";

// A 1×1 PNG: a real image, so the sign-off page can embed it.
const SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const signatureBytes = () => Uint8Array.from(Buffer.from(SIGNATURE.split(",")[1], "base64"));

describe("validateSignOff", () => {
  it("needs a typed name and a drawn signature", () => {
    expect(validateSignOff({ signedByName: " ", signatureImage: SIGNATURE }, 0)).toMatchObject({ ok: false });
    expect(validateSignOff({ signedByName: "Thabo M", signatureImage: "" }, 0)).toMatchObject({ ok: false });
    expect(validateSignOff({ signedByName: "Thabo M", signatureImage: "data:image/png;base64,AAAA" }, 0)).toMatchObject({ ok: false });
    expect(validateSignOff({ signedByName: "  Thabo   M ", signatureImage: SIGNATURE }, 0)).toMatchObject({
      ok: true,
      signedByName: "Thabo M",
      acknowledgement: null,
    });
  });

  it("needs a reason whenever the check found anything", () => {
    expect(validateSignOff({ signedByName: "Thabo", signatureImage: SIGNATURE }, 2)).toMatchObject({ ok: false });
    expect(validateSignOff({ signedByName: "Thabo", signatureImage: SIGNATURE, acknowledgement: "ok" }, 2)).toMatchObject({ ok: false });
    expect(
      validateSignOff({ signedByName: "Thabo", signatureImage: SIGNATURE, acknowledgement: "Agreed with accounts" }, 2)
    ).toMatchObject({ ok: true, acknowledgement: "Agreed with accounts" });
  });
});

describe("signedCreditFilename", () => {
  it("is CN{creditNo}_INV{invoiceNo}_COL{collectionNo}.pdf", () => {
    expect(signedCreditFilename("407712", "384281", ["1797"])).toBe("CN407712_INV384281_COL1797.pdf");
  });
  it("joins several collections, caps them, and leaves out what is missing", () => {
    expect(signedCreditFilename("407712", "384281", ["1797", "1800"])).toBe("CN407712_INV384281_COL1797-1800.pdf");
    expect(signedCreditFilename("407712", "IV/384281", ["1", "2", "3", "4", "5"])).toBe("CN407712_INVIV384281_COL1-2-3+2.pdf");
    expect(signedCreditFilename("CN-5001", null, [])).toBe("CNCN-5001.pdf");
  });
});

const pageData = (over: Partial<SignOffPageData> = {}): SignOffPageData => ({
  creditNo: "407712",
  creditDate: new Date("2026-10-16T00:00:00Z"),
  invoiceNo: "384281",
  customerName: "HELDERBERG MOTOR SPARES",
  accountNo: "C007H014",
  subtotal: 720,
  vatAmount: 108,
  total: 828,
  lines: [
    { lineNo: 1, productCode: "618ABG", description: "BATT BM-618B41LB1 41AH 360CCA", qty: 1, allocations: [{ collectionNo: "1797", qty: 1 }] },
  ],
  collections: [{ collectionNo: "1797", status: "COLLECTED", collectedAt: new Date("2026-10-15T09:00:00Z") }],
  acknowledged: [],
  acknowledgement: null,
  signedByName: "Thabo Mokoena",
  signedByLogin: "Dispatch JHB",
  signedAt: new Date("2026-10-18T10:30:00Z"),
  ...over,
});

const textOf = async (pdf: Buffer, page: number) =>
  (await extractPageItems(pdf))[page].map((i) => i.str).join(" ");

describe("the signed copy", () => {
  it("is the credit note with a sign-off page appended — never drawn over it", async () => {
    const original = await creditNotePdf();
    const { pdf, includesSource } = await buildSignedCreditNotePdf(original, pageData(), signatureBytes());

    expect(includesSource).toBe(true);
    const pages = (await PDFDocument.load(pdf)).getPageCount();
    expect(pages).toBe((await PDFDocument.load(original)).getPageCount() + 1);
    expect(await textOf(pdf, 0)).toContain("CR NOTE");
    const last = await textOf(pdf, pages - 1);
    expect(last).toContain("CREDIT NOTE SIGN-OFF");
    expect(last).toContain("407712");
    expect(last).toContain("Thabo Mokoena");
    expect(last).toContain("Dispatch JHB");
    expect(last).toContain("1 on 1797");
  });

  it("prints what was accepted and why", async () => {
    const { pdf } = await buildSignedCreditNotePdf(
      await creditNotePdf(),
      pageData({ acknowledged: [{ message: "Line 1 credits 2, but only 1 came back." }], acknowledgement: "Second unit collected by rep" }),
      signatureBytes()
    );
    const last = await textOf(pdf, (await PDFDocument.load(pdf)).getPageCount() - 1);
    expect(last).toContain("CHECKED AND ACCEPTED");
    expect(last).toContain("Second unit collected by rep");
  });

  it("stands alone, and says so, when the original cannot be read", async () => {
    const { pdf, includesSource } = await buildSignedCreditNotePdf(Buffer.from("not a pdf"), pageData(), signatureBytes());
    expect(includesSource).toBe(false);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
  });

  it("does not fail on a typed name the PDF font cannot draw", async () => {
    await expect(
      buildSignedCreditNotePdf(await creditNotePdf(), pageData({ signedByName: "Thabo 👍 Mokoena" }), signatureBytes())
    ).resolves.toBeTruthy();
  });

  it("carries on over the page with many lines", async () => {
    const lines = Array.from({ length: 70 }, (_, i) => ({
      lineNo: i + 1,
      productCode: `P${i}`,
      description: `PART ${i} WITH A LONGER DESCRIPTION THAN USUAL`,
      qty: 1,
      allocations: [],
    }));
    const { pdf } = await buildSignedCreditNotePdf(await creditNotePdf(), pageData({ lines }), signatureBytes());
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThan(2);
  });
});

describe("the collection receipt's credit reference", () => {
  it("is appended as a page of its own", async () => {
    const receipt = await creditNotePdf(); // any PDF stands in for a receipt
    const stamped = await appendCreditReference(receipt, {
      creditNo: "407712",
      creditDate: new Date("2026-10-16T00:00:00Z"),
      invoiceNo: "384281",
      total: 828,
      lines: [{ productCode: "618ABG", description: "BATT BM-618B41LB1", qty: 1 }],
      signedByName: "Thabo Mokoena",
      signedAt: new Date("2026-10-18T10:30:00Z"),
    });
    const pages = (await PDFDocument.load(stamped)).getPageCount();
    expect(pages).toBe((await PDFDocument.load(receipt)).getPageCount() + 1);
    const last = await textOf(stamped, pages - 1);
    expect(last).toContain("CREDIT NOTE REFERENCE");
    expect(last).toContain("618ABG");
  });
});
