/**
 * The signed collection receipt emailed to the customer.
 *
 * Mirrors the delivery confirmation's rules: only outcomes the customer signed
 * for are sent, a missing address is recorded rather than retried, the claim
 * stops two senders mailing the customer twice, and nothing here throws.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;

let row: Row | null;
let claimCount: number;
const updates: Row[] = [];
let contactsByName: Record<string, Row>;
const stopLinks: Row[] = [];

vi.mock("@/lib/db-scoped", () => ({
  scopedPrisma: () => ({
    collection: {
      findFirst: vi.fn(async () => row),
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        updates.push(args.data);
        // The claim is the only update whose data moves the row into SENDING.
        if (args.data.emailStatus === "SENDING") return { count: claimCount };
        return { count: 1 };
      }),
    },
    contact: {
      findFirst: vi.fn(async (args: { where: { companyName: { equals: string } } }) =>
        contactsByName[args.where.companyName.equals.toLowerCase()] ?? null
      ),
    },
    stop: {
      updateMany: vi.fn(async (args: { where: Row; data: Row }) => {
        stopLinks.push(args);
        return { count: 1 };
      }),
    },
  }),
}));

const sendCollectionReceipt = vi.fn();
vi.mock("@/lib/email", () => ({
  sendCollectionReceipt: (...args: unknown[]) => sendCollectionReceipt(...args),
}));

vi.mock("@/lib/collections", () => ({
  readSignedCollectionDocument: vi.fn(async () => Buffer.from("%PDF-signed")),
}));

import { sendCollectionReceiptEmail } from "@/lib/collection-notify";

const TENANT = "tenant-1";

function collection(overrides: Row = {}): Row {
  return {
    id: "col-1",
    collectionNo: "COL-118",
    type: "CREDIT_RETURN",
    upliftSubtype: null,
    status: "COLLECTED",
    expectedQty: 3,
    collectedQty: 3,
    signedByName: "Jane Doe",
    collectedAt: new Date("2026-10-03T10:00:00Z"),
    signedFilePath: "COL-118_COLLECTED.pdf",
    emailStatus: "NOT_SENT",
    driver: { name: "John Smith" },
    stop: {
      id: "stop-1",
      customerName: "Acme",
      contact: { email: "accounts@acme.example", companyName: "Acme", contactPerson: null },
    },
    ...overrides,
  };
}

beforeEach(() => {
  row = collection();
  claimCount = 1;
  updates.length = 0;
  stopLinks.length = 0;
  contactsByName = {};
  sendCollectionReceipt.mockReset();
  sendCollectionReceipt.mockResolvedValue({ success: true });
});

describe("sendCollectionReceiptEmail", () => {
  it("emails the signed sheet as an attachment and marks the row SENT", async () => {
    const result = await sendCollectionReceiptEmail(TENANT, "col-1");

    expect(result).toMatchObject({ outcome: "sent", sent: true, recipient: "accounts@acme.example" });
    const params = sendCollectionReceipt.mock.calls[0][0];
    expect(params.collectionNo).toBe("COL-118");
    expect(params.pdfAttachment.filename).toBe("COL-118_COLLECTED.pdf");
    expect(params.quantityLine).toBe("3 of 3");
    expect(updates.at(-1)).toMatchObject({ emailStatus: "SENT" });
  });

  it.each(["PENDING", "NOT_AVAILABLE", "REFUSED"])(
    "sends nothing for a %s collection — the customer signed for nothing",
    async (status) => {
      row = collection({ status });
      const result = await sendCollectionReceiptEmail(TENANT, "col-1");
      expect(result.outcome).toBe("not_signed");
      expect(sendCollectionReceipt).not.toHaveBeenCalled();
    }
  );

  it("sends a PARTIAL collection, which was signed for", async () => {
    row = collection({ status: "PARTIAL", collectedQty: 1 });
    const result = await sendCollectionReceiptEmail(TENANT, "col-1");
    expect(result.outcome).toBe("sent");
    expect(sendCollectionReceipt.mock.calls[0][0].outcomeLabel).toBe("Partly collected");
  });

  it("records NO_EMAIL instead of retrying when the customer has no address", async () => {
    row = collection({ stop: { id: "stop-1", customerName: "Acme", contact: null } });
    const result = await sendCollectionReceiptEmail(TENANT, "col-1");
    expect(result.outcome).toBe("no_email");
    expect(updates.at(-1)).toMatchObject({ emailStatus: "NO_EMAIL" });
    expect(sendCollectionReceipt).not.toHaveBeenCalled();
  });

  it("finds the contact by exact name when the stop was deployed unlinked", async () => {
    // The cloud-folder deploy used to skip contact linking, and a customer can
    // be added to Contacts after import. Either way the stop has no contact.
    row = collection({ stop: { id: "stop-1", customerName: "Vaal Triangle Networks", contact: null } });
    contactsByName["vaal triangle networks"] = {
      id: "contact-9",
      email: "ops@vaal.example",
      companyName: "Vaal Triangle Networks",
      contactPerson: null,
    };

    const result = await sendCollectionReceiptEmail(TENANT, "col-1");

    expect(result).toMatchObject({ outcome: "sent", recipient: "ops@vaal.example" });
    expect(stopLinks[0]).toEqual({
      where: { id: "stop-1", contactId: null },
      data: { contactId: "contact-9" },
    });
  });

  it("does not mail twice when another sender holds the claim", async () => {
    claimCount = 0;
    const result = await sendCollectionReceiptEmail(TENANT, "col-1");
    expect(result.outcome).toBe("in_flight");
    expect(sendCollectionReceipt).not.toHaveBeenCalled();
  });

  it("leaves an already-sent receipt alone unless forced", async () => {
    row = collection({ emailStatus: "SENT" });
    expect((await sendCollectionReceiptEmail(TENANT, "col-1")).outcome).toBe("already_sent");
    expect(sendCollectionReceipt).not.toHaveBeenCalled();

    expect((await sendCollectionReceiptEmail(TENANT, "col-1", { force: true })).outcome).toBe("sent");
  });

  it("records the transport's error and never throws", async () => {
    sendCollectionReceipt.mockResolvedValue({ success: false, error: "535 auth failed" });
    const result = await sendCollectionReceiptEmail(TENANT, "col-1");
    expect(result).toMatchObject({ outcome: "failed", error: "535 auth failed" });
    expect(updates.at(-1)).toMatchObject({ emailStatus: "FAILED", emailError: "535 auth failed" });
  });

  it("survives an unexpected throw without escaping", async () => {
    sendCollectionReceipt.mockRejectedValue(new Error("boom"));
    const result = await sendCollectionReceiptEmail(TENANT, "col-1");
    expect(result).toMatchObject({ outcome: "failed", error: "boom" });
  });
});
