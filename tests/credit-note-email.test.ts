/**
 * The customer's copy of a signed credit note, without a database: whose
 * name the contact is looked up by, which contact gets it, and what the
 * email says.
 */

import { describe, it, expect } from "vitest";
import { render } from "@react-email/render";
import { pickRecipient, recipientNames } from "@/lib/credit-note-email";
import { CreditNoteSigned } from "@/emails/CreditNoteSigned";

describe("recipientNames", () => {
  it("puts the invoice's customer first, then the collection, then the names on the note", () => {
    expect(
      recipientNames({
        invoiceCustomer: "HELDERBERG MOTOR SPARES",
        collectionCustomers: ["Helderberg Motor Spares (Pty)"],
        noteDeliverTo: "Helderberg Motor Spares",
        noteBillTo: "CASH SALES",
      })
    ).toEqual(["HELDERBERG MOTOR SPARES", "Helderberg Motor Spares (Pty)", "CASH SALES"]);
  });

  it("prefers Deliver to over Invoice to — on a cash sale Invoice to is the cash account", () => {
    expect(recipientNames({ noteBillTo: "CASH ACCOUNT", noteDeliverTo: "Visa Auto Electrical" })).toEqual([
      "Visa Auto Electrical",
      "CASH ACCOUNT",
    ]);
  });

  it("drops blanks and repeats", () => {
    expect(recipientNames({ invoiceCustomer: "  ", noteDeliverTo: null, invoiceDeliverTo: "A & B Motors", noteBillTo: "a and b motors." })).toEqual([
      "A & B Motors",
    ]);
    expect(recipientNames({})).toEqual([]);
  });
});

describe("pickRecipient", () => {
  const contacts = [
    { id: "1", companyName: "Helderberg Motor Spares", email: null, contactPerson: null },
    { id: "2", companyName: "HELDERBERG MOTOR SPARES", email: " parts@helderberg.test ", contactPerson: "Pieter" },
    { id: "3", companyName: "Cash Sales", email: "till@branch.test", contactPerson: null },
    { id: "4", companyName: "Helderberg Motor Spares Paarl", email: "paarl@helderberg.test", contactPerson: null },
  ];

  it("takes the first name with a contact that has an address — matched exactly, never fuzzily", () => {
    expect(pickRecipient(["Helderberg Motor Spares", "Cash Sales"], contacts)).toMatchObject({ id: "2", email: "parts@helderberg.test" });
    expect(pickRecipient(["Helderberg Motor"], contacts)).toBeNull();
  });

  it("falls through to the next name when the first has no address", () => {
    const noAddress = contacts.filter((c) => c.id !== "2");
    expect(pickRecipient(["Helderberg Motor Spares", "Cash Sales"], noAddress)).toMatchObject({ id: "3" });
    expect(pickRecipient(["Helderberg Motor Spares"], noAddress)).toBeNull();
  });
});

describe("the email", () => {
  const props = {
    customerName: "HELDERBERG MOTOR SPARES",
    contactPerson: "Pieter",
    companyName: "Signex Polokwane",
    creditNo: "407712",
    invoiceNo: "384281",
    collectionNos: ["CRC-23328"],
    creditDate: "12 Nov 2026",
    signedAt: "12/11/2026, 10:15",
  };

  it("names the note, the invoice and the collection, and says the copy is attached", async () => {
    const html = await render(CreditNoteSigned({ ...props, attached: true }));
    for (const s of ["407712", "384281", "CRC-23328", "12 Nov 2026", "Hi Pieter", "SIGNEX POLOKWANE", "is attached"]) {
      expect(html).toContain(s);
    }
  });

  it("says so when the copy was too large to attach", async () => {
    const html = await render(CreditNoteSigned({ ...props, attached: false }));
    expect(html).toContain("too large to attach");
    expect(html).not.toContain("is attached");
  });
});
