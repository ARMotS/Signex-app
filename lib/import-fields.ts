/**
 * import-fields.ts
 * The Signex fields an import template can point at, per sheet type.
 *
 * One list, read by the mapped parser (lib/sheet-mapping.ts), the template
 * checks and the mapping wizard. Adding a field is a change here only — the
 * parser and the wizard read whatever is listed.
 *
 * Field keys are stored inside saved templates, so they are permanent: rename
 * a label freely, never a key. The TRIP_SHEET keys are the ParsedRow property
 * names the trip parser has always produced, so mapped rows feed the stop
 * grouping, collections and invoice matching with no translation step.
 *
 * Order matters. When a built-in layout finds columns by their aliases, each
 * header is given to the FIRST field whose aliases match it — the same
 * first-match rule the trip parser has always used ("Collection" is a
 * collection number, not an invoice). Keep new fields at the end of a list
 * unless a header really should prefer them.
 *
 * No imports, so the wizard can run in the browser on the same list.
 */

export type ImportSheetType = "TRIP_SHEET" | "COURIER_TRIP_SHEET";

/** How a mapped cell is turned into a value. */
export type FieldValueType =
  /** Trimmed text. Blank is "". */
  | "text"
  /** A document number. Trimmed; "0", "-", "N/A" and the like read as blank. */
  | "reference"
  /** A whole number of things. Blank or unreadable is 0. */
  | "count"
  /** A whole number the office expects. Blank, unreadable or 0 is null. */
  | "quantity"
  /** A calendar date, as YYYY-MM-DD. Excel serial dates are read as dates. */
  | "date";

export interface ImportField {
  key: string;
  label: string;
  /**
   * `column` — one value per row. It can still be taken from a single cell (or
   * typed at import) when a sheet carries it once, e.g. the driver of a whole
   * run; that value then applies to every row.
   * `header` — one value per sheet: a cell, a column's first value, or typed.
   */
  kind: "column" | "header";
  /** Must be mapped before a template can be saved. */
  mustMap: boolean;
  /** Every row (or, for a header field, the sheet) must carry a value. */
  requiresValue: boolean;
  valueType: FieldValueType;
  /** Header spellings, used to find the column on a built-in layout and to
   *  suggest one in the wizard. Tested against the trimmed header text. */
  aliases: RegExp[];
  help?: string;
}

export interface SheetTypeDefinition {
  label: string;
  fields: ImportField[];
  /** Groups of which at least one field must be mapped. */
  mapAtLeastOne: string[][];
}

// ─── Trip sheet ───────────────────────────────────────────────────────────

const TRIP_SHEET_FIELDS: ImportField[] = [
  {
    key: "date",
    label: "Date",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    // Text, not a date: it is shown for reference only and has always been
    // carried exactly as the sheet wrote it.
    valueType: "text",
    aliases: [/^date$/i, /^trip\s*date$/i, /^delivery\s*date$/i, /^del\.\s*date$/i],
    help: "Reference only.",
  },
  {
    key: "driverName",
    label: "Driver",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "text",
    aliases: [/^driver\s*name$/i, /^driver$/i, /^assigned\s*to$/i, /^assigned$/i],
    help: "Matched to a driver on the Drivers page by name.",
  },
  {
    key: "regNo",
    label: "REG No",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "text",
    aliases: [
      /^regno$/i,
      /^reg\s*no\.?$/i,
      /^reg$/i,
      /^registration$/i,
      /^vehicle\s*reg/i,
      /^vehicle$/i,
      /^reg\s*num/i,
      /^plate/i,
      /^number\s*plate/i,
    ],
  },
  {
    key: "customerName",
    label: "Customer",
    kind: "column",
    mustMap: true,
    // A blank customer has always deployed as "Unknown".
    requiresValue: false,
    valueType: "text",
    aliases: [
      /^customer\s*name$/i,
      /^customer$/i,
      /^client\s*name$/i,
      /^client$/i,
      /^name$/i,
      /^company$/i,
      /^deliver\s*to$/i,
    ],
  },
  {
    key: "invoiceNumber",
    label: "Invoice No",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "reference",
    aliases: [
      /^invoiceno$/i,
      /^invoice\s*no\.?$/i,
      /^invoice\s*#?\s*n/i,
      /^invoice\s*#/i,
      /^invoice\s*num/i,
      /^inv\s*#/i,
      /^inv\.?\s*no/i,
      /^invoice$/i,
      /^inv$/i,
    ],
    help: "Matched to the invoice PDF. A row needs an invoice number, a collection number, or both.",
  },
  {
    key: "collectionNo",
    label: "Collection No",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "reference",
    // Tolerant on purpose: depots write COLLECTNO, "Collection No", "Coll No"
    // and "Collect #", and a header that fails to match silently drops every
    // collection on the sheet.
    aliases: [
      /^collectno$/i,
      /^collection\s*no\.?$/i,
      /^collect\s*no\.?$/i,
      /^coll\s*no\.?$/i,
      /^collection\s*#/i,
      /^collect\s*#/i,
      /^coll\s*#/i,
      /^collection\s*num/i,
      /^collection$/i,
      /^collect$/i,
    ],
  },
  {
    key: "collectionType",
    label: "Collection type",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "text",
    aliases: [
      /^collecttype$/i,
      /^collection\s*type$/i,
      /^collect\s*type$/i,
      /^coll\s*type$/i,
      /^uplift\s*type$/i,
    ],
    help: "Blank means a credit return.",
  },
  {
    key: "originalInvoiceNo",
    label: "Original invoice No",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "reference",
    aliases: [
      /^originalinvoiceno$/i,
      /^original\s*invoice\s*no\.?$/i,
      /^original\s*invoice$/i,
      /^orig\s*inv(oice)?\s*no\.?$/i,
      /^credit\s*against$/i,
      /^against\s*invoice$/i,
    ],
  },
  {
    key: "collectQty",
    label: "Collect qty",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "quantity",
    aliases: [
      /^collectqty$/i,
      /^collect\s*qty$/i,
      /^collection\s*qty$/i,
      /^coll\s*qty$/i,
      /^expected\s*qty$/i,
    ],
  },
  {
    key: "nop",
    label: "NOP (parcels)",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "count",
    aliases: [
      /^nop$/i,
      /^n\.?o\.?p\.?$/i,
      /^num\s*(of\s*)?parcels$/i,
      /^number\s*of\s*parcels$/i,
      /^parcels$/i,
      /^qty$/i,
      /^quantity$/i,
      /^pcs$/i,
      /^pieces$/i,
    ],
    help: "On a collection row, the number of packages to collect.",
  },
];

// ─── Courier trip sheet ───────────────────────────────────────────────────

const COURIER_TRIP_SHEET_FIELDS: ImportField[] = [
  {
    key: "invoiceNumber",
    label: "Invoice No",
    kind: "column",
    mustMap: true,
    requiresValue: true,
    valueType: "reference",
    aliases: [/^invoiceno$/i, /^invoice\s*no\.?:?$/i, /^invoice\s*#/i, /^invoice\s*num/i, /^inv\.?\s*no/i, /^invoice$/i],
  },
  {
    key: "waybillNo",
    label: "Waybill No",
    kind: "column",
    mustMap: true,
    requiresValue: true,
    valueType: "reference",
    aliases: [/^waybill\s*no\.?:?$/i, /^waybillno$/i, /^waybill\s*#/i, /^waybill\s*num/i, /^waybill$/i],
  },
  {
    key: "customerName",
    label: "Customer",
    kind: "column",
    mustMap: true,
    requiresValue: true,
    valueType: "text",
    aliases: [/^customer\s*name$/i, /^customer$/i, /^client$/i, /^consignee$/i],
  },
  {
    key: "invoiceDate",
    label: "Invoice date",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "date",
    aliases: [/^invoice\s*date$/i, /^date$/i],
  },
  {
    key: "parcels",
    label: "Parcels",
    kind: "column",
    mustMap: false,
    requiresValue: false,
    valueType: "count",
    aliases: [/^nop$/i, /^no\.?\s*of\s*parcels$/i, /^num\s*(of\s*)?parcels$/i, /^parcels$/i, /^pcs$/i],
    help: "Often filled on the first row only; the filled value is the consignment total.",
  },
  {
    key: "courierSheetNo",
    label: "Courier sheet No",
    kind: "header",
    mustMap: true,
    requiresValue: true,
    valueType: "reference",
    aliases: [],
    help: "The client's export carries it in the filename, not the sheet.",
  },
  {
    key: "sheetDate",
    label: "Sheet date",
    kind: "header",
    mustMap: false,
    // Falls back to the import date when not mapped.
    requiresValue: false,
    valueType: "date",
    aliases: [],
  },
  {
    key: "courierCompany",
    label: "Courier company",
    kind: "header",
    mustMap: false,
    // Can also be typed at import or at signing.
    requiresValue: false,
    valueType: "text",
    aliases: [],
  },
  {
    key: "courierService",
    label: "Courier service",
    kind: "header",
    mustMap: false,
    requiresValue: false,
    valueType: "text",
    aliases: [],
  },
  {
    key: "courierContact",
    label: "Courier contact",
    kind: "header",
    mustMap: false,
    requiresValue: false,
    valueType: "text",
    aliases: [],
  },
];

export const SHEET_TYPES: Record<ImportSheetType, SheetTypeDefinition> = {
  TRIP_SHEET: {
    label: "Trip sheet",
    fields: TRIP_SHEET_FIELDS,
    mapAtLeastOne: [["invoiceNumber", "collectionNo"]],
  },
  COURIER_TRIP_SHEET: {
    label: "Courier trip sheet",
    fields: COURIER_TRIP_SHEET_FIELDS,
    mapAtLeastOne: [],
  },
};

export function fieldsFor(sheetType: ImportSheetType): ImportField[] {
  return SHEET_TYPES[sheetType].fields;
}

// ─── Header matching ──────────────────────────────────────────────────────

/** The field a header names on this sheet type, by alias; first field wins. */
export function fieldForHeader(header: string, sheetType: ImportSheetType): string | null {
  const trimmed = String(header ?? "").trim();
  if (!trimmed) return null;

  for (const field of fieldsFor(sheetType)) {
    if (field.aliases.some((pattern) => pattern.test(trimmed))) return field.key;
  }
  return null;
}

/** Header text as compared between a template and a file. */
export function normalizeHeader(header: string): string {
  return String(header ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// ─── Cell values ──────────────────────────────────────────────────────────

/**
 * A cell that is filled in but means "nothing here". Depots write "0", the
 * letter "O" or a dash in INVOICENO / COLLECTNO rather than leaving the cell
 * blank, and taken literally that is an invoice called "0" with no PDF, or a
 * collection called "-" for the driver to go and fetch.
 */
export function isPlaceholderCell(raw: string): boolean {
  return /^(?:[0O]+(?:\.0+)?|[-–—‐‑−_.]+|N\/?A|NIL|NONE|NULL)$/i.test(String(raw ?? "").trim());
}
