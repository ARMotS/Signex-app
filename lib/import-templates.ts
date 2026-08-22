/**
 * import-templates.ts
 * Builds the blank .xlsx workbooks an ADMIN downloads before preparing a trip
 * sheet or a contacts import.
 *
 * The headers written here are the canonical spellings that
 * `lib/trip-parser.ts` and `lib/contact-parser.ts` detect. Both parsers are
 * forgiving — they fuzzy-match a range of header spellings — but a sheet built
 * from the template hits the exact-match path, so column detection cannot
 * silently pick the wrong column or miss one.
 *
 * Sheet order matters. Both parsers read `workbook.SheetNames[0]` and ignore
 * every other sheet, so:
 *   - sheet 0 carries the header row and nothing else — it is ready to fill in
 *   - the worked example lives on its own sheet, where it can never be imported
 *     as real data if the admin forgets to delete it
 *   - the instructions and reference sheets are likewise inert
 *
 * `tests/import-templates.test.ts` feeds these headers back through the real
 * parsers, so a header rename on either side fails there rather than on a live
 * upload.
 *
 * Presentation is limited to column widths on purpose. Cell styling and frozen
 * panes are SheetJS Pro features — the community build we ship accepts `!freeze`
 * and a cell `s` property and then drops both on write, so anything relying on
 * them would look correct in code and be absent from the downloaded file.
 */

import * as XLSX from "xlsx";

// ─── Canonical headers ────────────────────────────────────────────────────

export const TRIP_SHEET_TEMPLATE_HEADERS = [
  "Date",
  "Driver",
  "REGNO",
  "Customer",
  "INVOICENO",
  "NOP",
] as const;

export const CONTACTS_TEMPLATE_HEADERS = [
  "Company Name",
  "Contact Person",
  "Email",
  "Phone",
  "Alt Phone",
  "Address",
  "Notes",
] as const;

export const TRIP_SHEET_TEMPLATE_FILENAME = "signex-trip-sheet-template.xlsx";
export const CONTACTS_TEMPLATE_FILENAME = "signex-contacts-template.xlsx";

type Row = (string | number)[];

// ─── Sheet helpers ────────────────────────────────────────────────────────

function sheetFromRows(rows: Row[], widths: number[]): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = widths.map((wch) => ({ wch }));
  return ws;
}

function instructionSheet(title: string, intro: string[], table: Row[]): XLSX.WorkSheet {
  const rows: Row[] = [[title], [""]];
  for (const line of intro) rows.push([line]);
  rows.push([""]);
  rows.push(...table);
  return sheetFromRows(rows, [22, 12, 62, 44]);
}

// ─── Trip sheet template ──────────────────────────────────────────────────

const TRIP_SHEET_EXAMPLE_ROWS: Row[] = [
  ["2026-08-24", "John Smith", "CA 123-456", "Acme Hardware", "INV-2041", 3],
  ["2026-08-24", "John Smith", "CA 123-456", "Beta Supplies", "INV-2042", 1],
  ["2026-08-24", "Thandi Nkosi", "CJ 998-221", "Cape Fittings", "INV-2043", 12],
];

const TRIP_SHEET_COLUMN_GUIDE: Row[] = [
  ["Column", "Required", "What it does", "Format / example"],
  [
    "Date",
    "Optional",
    "Reference only — the delivery date shown on the sheet. It is not used to match anything.",
    "2026-08-24",
  ],
  [
    "Driver",
    "Required",
    "Assigns the stop to a driver. Must match a driver name on your Drivers page exactly (capitals do not matter). Rows whose driver is not recognised land in an Unassigned group on the preview.",
    "John Smith — see the Drivers tab",
  ],
  [
    "REGNO",
    "Optional",
    "Vehicle registration for this trip. Recorded against the trip sheet; it does not pick the driver.",
    "CA 123-456",
  ],
  [
    "Customer",
    "Recommended",
    "Shown to the driver on the delivery run. A blank customer appears as Unknown.",
    "Acme Hardware",
  ],
  [
    "INVOICENO",
    "Required",
    "Matched to the invoice PDF in your invoice folder. A row with no invoice number is skipped entirely.",
    "INV-2041 — Invoice # 2041 and 2041 match the same PDF",
  ],
  [
    "NOP",
    "Optional",
    "Number of parcels, shown to the driver. Anything that is not a number counts as 0.",
    "3",
  ],
];

const TRIP_SHEET_INTRO = [
  "Fill in the Trip Sheet tab — it is the only tab that gets imported. The other tabs are reference only and are ignored on upload.",
  "Keep the header row exactly as it is, and keep it as the first row. Do not add a title or a blank row above it.",
  "One row per delivery stop. A row needs at least an invoice number to be imported.",
  "Save as .xlsx (or .csv) and upload it on the Trip Sheet page. You get a preview before anything reaches a driver.",
];

/**
 * @param driverNames the calling scope's driver names, used only to fill the
 * reference tab. An exact-spelling mismatch is the main reason stops arrive
 * unassigned, so the template ships the answer rather than describing it.
 */
export function buildTripSheetTemplate(driverNames: string[] = []): Buffer {
  const wb = XLSX.utils.book_new();
  const widths = [14, 22, 16, 30, 18, 8];

  // Sheet 0 — the only sheet the parser reads.
  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows([[...TRIP_SHEET_TEMPLATE_HEADERS]], widths),
    "Trip Sheet"
  );

  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows([[...TRIP_SHEET_TEMPLATE_HEADERS], ...TRIP_SHEET_EXAMPLE_ROWS], widths),
    "Example"
  );

  XLSX.utils.book_append_sheet(
    wb,
    instructionSheet("Signex — trip sheet upload", TRIP_SHEET_INTRO, TRIP_SHEET_COLUMN_GUIDE),
    "Instructions"
  );

  const driverRows: Row[] = [
    ["Copy these names into the Driver column exactly as they appear here."],
    [""],
    ["Driver name"],
  ];
  if (driverNames.length > 0) {
    for (const name of driverNames) driverRows.push([name]);
  } else {
    driverRows.push(["No drivers yet — add them on the Drivers page first."]);
  }
  XLSX.utils.book_append_sheet(wb, sheetFromRows(driverRows, [58]), "Drivers");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// ─── Contacts template ────────────────────────────────────────────────────

const CONTACTS_EXAMPLE_ROWS: Row[] = [
  [
    "Acme Hardware",
    "Jane Dube",
    "orders@acmehardware.co.za",
    "021 555 0134",
    "082 555 0134",
    "14 Voortrekker Rd, Bellville, 7530",
    "Deliveries before 15:00",
  ],
  [
    "Beta Supplies",
    "Sipho Mahlangu",
    "sipho@betasupplies.co.za",
    "011 555 0199",
    "",
    "8 Marine Drive, Durban, 4001",
    "",
  ],
];

const CONTACTS_COLUMN_GUIDE: Row[] = [
  ["Column", "Required", "What it does", "Format / example"],
  [
    "Company Name",
    "Required",
    "Matched against the Customer column of your trip sheets, and used to find an existing contact on re-import. A row with no company name is skipped.",
    "Acme Hardware",
  ],
  [
    "Contact Person",
    "Optional",
    "Person to ask for at the door.",
    "Jane Dube",
  ],
  [
    "Email",
    "Recommended",
    "Where the delivery confirmation is sent when the customer signs. Without it the stop is marked No email and lands in the dispatcher queue instead.",
    "orders@acmehardware.co.za",
  ],
  ["Phone", "Optional", "Main contact number.", "021 555 0134"],
  [
    "Alt Phone",
    "Optional",
    "Second number, tried if the first does not answer.",
    "082 555 0134",
  ],
  [
    "Address",
    "Optional",
    "Delivery address, shown to the driver.",
    "14 Voortrekker Rd, Bellville, 7530",
  ],
  [
    "Notes",
    "Optional",
    "Anything the driver should know — access, hours, gate code.",
    "Deliveries before 15:00",
  ],
];

const CONTACTS_INTRO = [
  "Fill in the Contacts tab — it is the only tab that gets imported. The other tabs are reference only and are ignored on upload.",
  "Keep the header row exactly as it is, and keep it as the first row. Do not add a title or a blank row above it.",
  "One row per company. Leave a cell blank rather than typing n/a or a dash.",
  "Re-importing a company you already have is safe: it is skipped by default, or refreshed if you tick Update existing contacts on the preview.",
  "Company Name is matched ignoring capitals, so ACME Hardware and Acme Hardware are treated as the same contact.",
];

export function buildContactsTemplate(): Buffer {
  const wb = XLSX.utils.book_new();
  const widths = [30, 22, 32, 18, 18, 42, 34];

  // Sheet 0 — the only sheet the parser reads.
  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows([[...CONTACTS_TEMPLATE_HEADERS]], widths),
    "Contacts"
  );

  XLSX.utils.book_append_sheet(
    wb,
    sheetFromRows([[...CONTACTS_TEMPLATE_HEADERS], ...CONTACTS_EXAMPLE_ROWS], widths),
    "Example"
  );

  XLSX.utils.book_append_sheet(
    wb,
    instructionSheet("Signex — contacts import", CONTACTS_INTRO, CONTACTS_COLUMN_GUIDE),
    "Instructions"
  );

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
