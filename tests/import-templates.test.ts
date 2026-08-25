/**
 * The downloadable .xlsx templates exist to stop admins guessing at column
 * names, so the guarantee worth testing is not "a file is produced" but "a
 * sheet built from this template is understood by the parser that will read
 * it". Both sides are asserted against the real parser code, so renaming a
 * header on either side fails here rather than at 6am on a live upload.
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  buildTripSheetTemplate,
  buildContactsTemplate,
  TRIP_SHEET_TEMPLATE_HEADERS,
  CONTACTS_TEMPLATE_HEADERS,
} from "@/lib/import-templates";
import { detectColumn } from "@/lib/trip-parser";
import { parseContactSheet } from "@/lib/contact-parser";

type Row = (string | number)[];

function readSheet(buffer: Buffer, name: string): Row[] {
  const wb = XLSX.read(buffer, { type: "buffer" });
  expect(wb.SheetNames).toContain(name);
  return XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { header: 1, defval: "" });
}

/** Fill in sheet 0 the way an admin would, and hand back the saved workbook. */
function fillFirstSheet(template: Buffer, rows: Row[]): Buffer {
  const wb = XLSX.read(template, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  XLSX.utils.sheet_add_aoa(sheet, rows, { origin: -1 });
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("trip sheet template", () => {
  it("puts the fill-in sheet first, because the parser reads only sheet 0", () => {
    const wb = XLSX.read(buildTripSheetTemplate(["John Smith"]), { type: "buffer" });
    expect(wb.SheetNames[0]).toBe("Trip Sheet");
  });

  it("ships sheet 0 with the header row and no data rows", () => {
    // A worked example left on sheet 0 would import as a real delivery.
    const rows = readSheet(buildTripSheetTemplate([]), "Trip Sheet");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([...TRIP_SHEET_TEMPLATE_HEADERS]);
  });

  it("uses headers the parser maps to the intended fields", () => {
    expect(TRIP_SHEET_TEMPLATE_HEADERS.map(detectColumn)).toEqual([
      "date",
      "driverName",
      "regNo",
      "customerName",
      "invoiceNumber",
      "nop",
    ]);
  });

  it("keeps the worked example on its own sheet, out of the parser's reach", () => {
    const example = readSheet(buildTripSheetTemplate([]), "Example");
    expect(example[0]).toEqual([...TRIP_SHEET_TEMPLATE_HEADERS]);
    expect(example.length).toBeGreaterThan(1);
  });

  it("lists the caller's own driver names for exact copying", () => {
    // Driver matching is an exact (case-insensitive) name lookup, so a
    // misspelling silently dumps the stop into the Unassigned group.
    const names = ["Thandi Nkosi", "John Smith"];
    const flat = readSheet(buildTripSheetTemplate(names), "Drivers").flat();
    for (const name of names) expect(flat).toContain(name);
  });

  it("says so plainly when the scope has no drivers yet", () => {
    const text = readSheet(buildTripSheetTemplate([]), "Drivers").flat().join(" ");
    expect(text).toMatch(/no drivers yet/i);
  });

  it("round-trips a filled-in sheet through the parser's own read path", () => {
    // The exact call sequence lib/trip-parser.ts uses on an uploaded file.
    const filled = fillFirstSheet(buildTripSheetTemplate(["John Smith"]), [
      ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", 3],
    ]);
    const wb = XLSX.read(filled, { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json<Row>(wb.Sheets[wb.SheetNames[0]], { header: 1 });

    expect(rows).toHaveLength(2);

    const columnMap: Record<string, number> = {};
    (rows[0] as string[]).forEach((header, i) => {
      const field = detectColumn(header);
      if (field && !(field in columnMap)) columnMap[field] = i;
    });

    expect(rows[1][columnMap.driverName]).toBe("John Smith");
    expect(rows[1][columnMap.invoiceNumber]).toBe("INV-2041");
    expect(parseInt(String(rows[1][columnMap.nop]))).toBe(3);
  });
});

describe("contacts template", () => {
  it("puts the fill-in sheet first, because the parser reads only sheet 0", () => {
    const wb = XLSX.read(buildContactsTemplate(), { type: "buffer" });
    expect(wb.SheetNames[0]).toBe("Contacts");
  });

  it("ships sheet 0 with the header row and no data rows", () => {
    const rows = readSheet(buildContactsTemplate(), "Contacts");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual([...CONTACTS_TEMPLATE_HEADERS]);
  });

  it("parses an untouched template as zero contacts, not as junk", async () => {
    const parsed = await parseContactSheet(buildContactsTemplate(), "", "template.xlsx");
    expect(parsed).toEqual([]);
  });

  it("maps every template column onto the right contact field", async () => {
    const filled = fillFirstSheet(buildContactsTemplate(), [
      [
        "Acme Hardware",
        "Jane Dube",
        "orders@acmehardware.co.za",
        "021 555 0134",
        "082 555 0134",
        "14 Voortrekker Rd, Bellville, 7530",
        "Deliveries before 15:00",
      ],
    ]);

    const parsed = await parseContactSheet(filled, "", "contacts.xlsx");

    expect(parsed).toEqual([
      {
        companyName: "Acme Hardware",
        contactPerson: "Jane Dube",
        email: "orders@acmehardware.co.za",
        phone: "021 555 0134",
        altPhone: "082 555 0134",
        address: "14 Voortrekker Rd, Bellville, 7530",
        notes: "Deliveries before 15:00",
      },
    ]);
  });

  it("does not confuse Alt Phone with Phone", async () => {
    // "alt phone" also matches the looser phone rule, so ordering in the
    // header map is load-bearing.
    const filled = fillFirstSheet(buildContactsTemplate(), [
      ["Beta Supplies", "", "", "011 555 0199", "082 555 0199", "", ""],
    ]);
    const [contact] = await parseContactSheet(filled, "", "contacts.xlsx");

    expect(contact.phone).toBe("011 555 0199");
    expect(contact.altPhone).toBe("082 555 0199");
  });

  it("keeps the worked example on its own sheet, out of the parser's reach", () => {
    const example = readSheet(buildContactsTemplate(), "Example");
    expect(example[0]).toEqual([...CONTACTS_TEMPLATE_HEADERS]);
    expect(example.length).toBeGreaterThan(1);
  });
});
