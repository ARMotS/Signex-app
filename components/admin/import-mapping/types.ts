/**
 * What the import template routes answer, as the browser sees it.
 * Mirrors app/api/import-templates/* — the reader's own types are imported
 * as types only, so nothing server-side (SheetJS) reaches the bundle.
 */

import type { ImportSheetType } from "@/lib/import-fields";
import type {
  FieldMapping,
  MappedRow,
  MappedValue,
  MappingIssue,
  MissingColumn,
  SheetTemplate,
  TemplateCheck,
} from "@/lib/sheet-mapping";

export type { FieldMapping, ImportSheetType, SheetTemplate };

export interface TemplateSummary {
  id: string;
  sheetType: ImportSheetType;
  name: string;
  isDefault: boolean;
  worksheet: string | null;
  headerRow: number;
  dataStartRow: number;
  stopAtBlankRows: number;
  mappings: Record<string, FieldMapping>;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BuiltInLayout {
  id: string;
  sheetType: ImportSheetType;
  name: string;
}

export interface TemplatePrompt {
  key: string;
  label: string;
}

/** The template that read (or was meant to read) a trip sheet upload. */
export interface TemplateRef {
  id: string;
  name: string;
  prompts?: TemplatePrompt[];
}

export interface PreviewResponse {
  sheetNames: string[];
  worksheet: string | null;
  rowCount: number;
  grid: string[][];
  detectedHeaderRow: number;
  headers: string[];
  prompts: TemplatePrompt[];
  suggestions: Record<string, FieldMapping>;
  template: SheetTemplate;
  check: TemplateCheck;
  result: {
    columns: Record<string, number>;
    missingColumns: MissingColumn[];
    header: Record<string, MappedValue>;
    rowCount: number;
    rows: MappedRow[];
    issues: MappingIssue[];
    issueCount: number;
  };
  trip:
    | null
    | { error?: string }
    | {
        totalRows: number;
        matchedInvoices: number;
        unmatchedInvoices: number;
        missingInvoices: { invoiceNumber: string; customerName: string; driverName: string }[];
        alreadySigned: number;
        totalCollections: number;
        drivers: { driverId: string; driverName: string; stops: number }[];
      };
}

/** The editable part of a template while the wizard is open. */
export type DraftTemplate = Pick<
  SheetTemplate,
  "worksheet" | "headerRow" | "dataStartRow" | "stopAtBlankRows" | "mappings"
>;

/** "A" for 0, "AB" for 27 — without SheetJS in the browser. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

export function columnIndexOf(letter: string | undefined): number | null {
  const v = String(letter ?? "").trim().toUpperCase();
  if (!/^[A-Z]{1,3}$/.test(v)) return null;
  let n = 0;
  for (const ch of v) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
