import { describe, expect, it } from "vitest";
import { buildPickerRows, pickerPageOf, type PickerFile, type PickerQuery } from "@/lib/invoice-picker";
import { allocationOf, type InvoiceAllocation } from "@/lib/invoice-allocation";
import { EMPTY_FILTER } from "@/lib/record-filter";
import { compileInvoiceNoPattern } from "@/lib/invoice-number";

const file = (name: string, lastModified = "2026-11-20T08:00:00Z", isSigned = false): PickerFile => ({
  name,
  filename: `${name}.pdf`,
  lastModified,
  isSigned,
});

const record = (id: string, extra: { invoiceDate?: string; customerName?: string; deliverToName?: string } = {}) => ({
  id,
  invoiceDate: extra.invoiceDate ? new Date(`${extra.invoiceDate}T00:00:00Z`) : null,
  customerName: extra.customerName ?? null,
  deliverToName: extra.deliverToName ?? null,
  billToName: null,
});

const onRun = (tripName: string, driverName: string): InvoiceAllocation =>
  allocationOf({ stops: [{ status: "PENDING", tripSheetId: "t1", tripName, driverName }], courier: [], signedCopy: false });

const query = (over: Partial<PickerQuery> = {}): PickerQuery => ({
  filter: { ...EMPTY_FILTER },
  showAll: false,
  tzOffset: 0,
  names: [],
  ...over,
});

describe("buildPickerRows", () => {
  it("takes the date and customer from the registry and the state from the allocation", () => {
    const rows = buildPickerRows(
      [file("IV-2041"), file("IV-2042")],
      new Map([
        ["2041", record("r1", { invoiceDate: "2026-11-19", customerName: "Acme Hardware" })],
        ["2042", record("r2", { deliverToName: "Beta Builders" })],
      ]),
      new Map([["2042", onRun("ts-102371-p5", "Sipho")]]),
      null
    );
    expect(rows[0]).toMatchObject({
      key: "2041",
      invoiceNo: "IV-2041",
      filename: "IV-2041.pdf",
      recordId: "r1",
      invoiceDate: "2026-11-19",
      customerName: "Acme Hardware",
      state: "AVAILABLE",
      stateLabel: "Available",
      selectable: true,
      run: null,
    });
    // Until a trip sheet names the customer, the PDF's name stands in.
    expect(rows[1]).toMatchObject({
      customerName: "Beta Builders",
      state: "ON_RUN",
      selectable: false,
      run: { tripName: "ts-102371-p5", driverName: "Sipho" },
    });
  });

  it("an unregistered file with no allocation reads AVAILABLE; a file with no number cannot be picked", () => {
    const rows = buildPickerRows([file("IV-7"), file("scan")], new Map(), new Map(), null);
    expect(rows[0]).toMatchObject({ key: "7", state: "AVAILABLE", selectable: true, recordId: null, invoiceDate: null });
    expect(rows[1]).toMatchObject({ key: "", state: "NO_NUMBER", stateLabel: "No invoice number", selectable: false });
  });

  it("marks two copies of one invoice number as duplicates", () => {
    const rows = buildPickerRows([file("INV-2041"), file("2041"), file("IV-2050")], new Map(), new Map(), null);
    expect(rows.map((r) => [r.key, r.duplicate])).toEqual([
      ["2041", true],
      ["2041", true],
      ["2050", false],
    ]);
  });

  it("keys by the scope's own invoice-number pattern", () => {
    const pattern = compileInvoiceNoPattern("^SO(?<num>\\d+)-\\d+$");
    expect(pattern.ok).toBe(true);
    const rows = buildPickerRows([file("SO1047-3")], new Map(), new Map(), pattern.ok ? pattern.pattern : null);
    expect(rows[0].key).toBe("1047");
  });
});

describe("pickerPageOf", () => {
  const rows = buildPickerRows(
    [
      file("IV-1001", "2026-11-01T08:00:00Z"),
      file("IV-1002", "2026-11-02T08:00:00Z"),
      file("IV-1003", "2026-11-03T08:00:00Z"),
      file("IV-1004", "2026-11-04T08:00:00Z"),
      file("scan", "2026-11-05T08:00:00Z"),
    ],
    new Map([
      ["1001", record("r1", { invoiceDate: "2026-10-30", customerName: "Acme Hardware" })],
      ["1002", record("r2", { customerName: "Beta Builders" })],
    ]),
    new Map([["1003", onRun("ts-1", "Sipho")]]),
    null
  );

  it("lists only what can be picked by default, newest first, and counts both", () => {
    const page = pickerPageOf(rows, query(), 1, 25);
    expect(page.items.map((r) => r.invoiceNo)).toEqual(["IV-1004", "IV-1002", "IV-1001"]);
    expect(page.total).toBe(3);
    expect(page.counts).toEqual({ available: 3, all: 5 });
  });

  it("show all lists allocated and unnumbered files too", () => {
    const page = pickerPageOf(rows, query({ showAll: true }), 1, 25);
    expect(page.total).toBe(5);
    expect(page.items.map((r) => r.state)).toContain("ON_RUN");
    expect(page.items.map((r) => r.state)).toContain("NO_NUMBER");
  });

  it("searches invoice number and customer", () => {
    expect(pickerPageOf(rows, query({ filter: { ...EMPTY_FILTER, q: "beta" } }), 1, 25).items.map((r) => r.invoiceNo)).toEqual(["IV-1002"]);
    expect(pickerPageOf(rows, query({ filter: { ...EMPTY_FILTER, q: "iv 1001" } }), 1, 25).items.map((r) => r.invoiceNo)).toEqual(["IV-1001"]);
  });

  it("filters dates on the invoice's own date, and on the file's while the header is unread", () => {
    const page = pickerPageOf(rows, query({ filter: { ...EMPTY_FILTER, from: "2026-11-01", to: "2026-11-02" } }), 1, 25);
    // IV-1001's own date (30 Oct) is outside, though its file is from 1 Nov.
    expect(page.items.map((r) => r.invoiceNo)).toEqual(["IV-1002"]);
  });

  it("pages, and a page past the end answers the last", () => {
    const first = pickerPageOf(rows, query({ showAll: true }), 1, 2);
    expect(first.items).toHaveLength(2);
    expect(first.page).toBe(1);
    const past = pickerPageOf(rows, query({ showAll: true }), 9, 2);
    expect(past.page).toBe(3);
    expect(past.items).toHaveLength(1);
  });

  it("answers for named files whatever the filter, in any case", () => {
    const page = pickerPageOf(rows, query({ filter: { ...EMPTY_FILTER, q: "nothing-matches" }, names: ["iv-1003.PDF", "IV-1004.pdf"] }), 1, 25);
    expect(page.items).toHaveLength(0);
    expect(page.named.map((r) => [r.invoiceNo, r.selectable])).toEqual([
      ["IV-1003", false],
      ["IV-1004", true],
    ]);
  });
});
