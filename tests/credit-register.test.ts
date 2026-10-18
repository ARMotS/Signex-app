import { describe, it, expect } from "vitest";
import { creditRegisterCsv, type CreditRegisterRow } from "@/lib/credit-register";

const row = (over: Partial<CreditRegisterRow> = {}): CreditRegisterRow => ({
  creditNo: "407712",
  creditDate: "2026-10-16",
  invoiceNo: "384281",
  invoiceDate: "2026-10-01",
  customer: "HELDERBERG MOTOR SPARES",
  accountNo: "C007H014",
  collections: "1797",
  collectedOn: "2026-10-15",
  itemsCredited: "1 x 618ABG (collection 1797)",
  subtotal: "720.00",
  vat: "108.00",
  total: "828.00",
  signedBy: "Thabo Mokoena",
  signedByLogin: "Dispatch JHB",
  signedAt: "2026-10-18T10:30:00.000Z",
  acceptedIssues: "",
  reason: "",
  signedFile: "CN407712_INV384281_COL1797.pdf",
  ...over,
});

describe("creditRegisterCsv", () => {
  it("has a header row and one row per note, opening as UTF-8 in Excel", () => {
    const csv = creditRegisterCsv([row(), row({ creditNo: "407713" })]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "Credit note,Credit date,Invoice,Invoice date,Customer,Account,Collections,Collected on,Items credited,Sub total,VAT,Total,Signed by,Office login,Signed at,Accepted despite,Reason,Signed file"
    );
    expect(lines[1]).toContain("407712,2026-10-16,384281");
  });

  it("quotes commas, quotes and line breaks", () => {
    const csv = creditRegisterCsv([row({ customer: 'SMITH, "JR" MOTORS', reason: "line one\nline two" })]);
    expect(csv).toContain('"SMITH, ""JR"" MOTORS"');
    expect(csv).toContain('"line one\nline two"');
  });

  it("never lets a spreadsheet run a cell as a formula", () => {
    const csv = creditRegisterCsv([row({ customer: "=HYPERLINK(\"x\")", reason: "+1", signedBy: "@me" })]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain("'+1");
    expect(csv).toContain("'@me");
  });

  it("is only a header when there are no notes", () => {
    expect(creditRegisterCsv([]).slice(1).trimEnd().split("\r\n")).toHaveLength(1);
  });
});
