/**
 * contact-parser.ts
 * Parses uploaded spreadsheets or PDFs into structured contact data.
 * - CSV/Excel: column mapping with fuzzy header detection via xlsx
 * - PDF: text extraction via pdf.js-extract + Claude AI parsing
 */

import Anthropic from "@anthropic-ai/sdk";
import * as XLSX from "xlsx";

export interface ParsedContact {
  companyName: string;
  contactPerson?: string;
  email?: string;
  phone?: string;
  altPhone?: string;
  address?: string;
  notes?: string;
}

// ─── Column header mapping ───────────────────────────────────────────────────
// Matches exact field labels from the manual add form first, then fuzzy fallback.

const EXACT_MAP: Record<string, keyof ParsedContact> = {
  "company name": "companyName",
  "companyname": "companyName",
  "contact person": "contactPerson",
  "contactperson": "contactPerson",
  "email": "email",
  "phone": "phone",
  "alt phone": "altPhone",
  "altphone": "altPhone",
  "address": "address",
  "notes": "notes",
};

function mapHeader(header: string): keyof ParsedContact | null {
  const h = header.toLowerCase().trim();

  const exact = EXACT_MAP[h];
  if (exact) return exact;

  if (h.includes("company") || h === "name" || h === "business" || h === "customer") return "companyName";
  if (h.includes("contact") || h.includes("person") || h.includes("rep") || h.includes("attn")) return "contactPerson";
  if (h.includes("email") || h.includes("e-mail") || h.includes("mail")) return "email";
  if (h.includes("alt") && (h.includes("phone") || h.includes("tel") || h.includes("cell"))) return "altPhone";
  if (h.includes("alternative") || h.includes("second phone") || h.includes("other phone")) return "altPhone";
  if (h.includes("phone") || h.includes("tel") || h.includes("mobile") || h.includes("cell") || h.includes("fax")) return "phone";
  if (h.includes("address") || h.includes("addr") || h.includes("location")) return "address";
  if (h.includes("note") || h.includes("comment") || h.includes("remark")) return "notes";
  return null;
}

// ─── CSV / Excel parser ───────────────────────────────────────────────────────

function parseSpreadsheet(buffer: Buffer): ParsedContact[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  if (rows.length === 0) return [];

  // Build header→field map from first row keys
  const headerMap = new Map<string, keyof ParsedContact>();
  for (const key of Object.keys(rows[0])) {
    const field = mapHeader(key);
    if (field) headerMap.set(key, field);
  }

  const contacts: ParsedContact[] = [];

  for (const row of rows) {
    const contact: Partial<ParsedContact> = {};
    for (const [col, field] of headerMap) {
      const val = String(row[col] ?? "").trim();
      if (val) (contact as Record<string, string>)[field] = val;
    }
    if (contact.companyName) {
      contacts.push(contact as ParsedContact);
    }
  }

  return contacts;
}

// ─── PDF parser (Claude AI) ───────────────────────────────────────────────────

async function parsePDF(buffer: Buffer): Promise<ParsedContact[]> {
  // Dynamic import to avoid bundler issues with pdf.js-extract
  const { PDFExtract } = await import("pdf.js-extract");
  const extractor = new PDFExtract();

  const data = await extractor.extractBuffer(buffer, {});
  const text = data.pages
    .flatMap((page) => page.content.map((item) => item.str))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length < 10) {
    throw new Error("PDF appears to contain no extractable text.");
  }

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const prompt = `You are a data extraction assistant. Extract all contact/company entries from the following document text and return them as a JSON array.

Each object must have these fields (all optional except companyName):
- companyName (string, required)
- contactPerson (string)
- email (string)
- phone (string)
- altPhone (string)
- address (string)
- notes (string)

Return ONLY valid JSON array, no markdown, no explanation.

Document text:
${text}`;

  const message = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const responseText = message.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("");

  // Strip markdown code fences if present
  const cleaned = responseText.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Claude response was not a JSON array.");
  }

  return (parsed as Record<string, string>[])
    .filter((item) => typeof item.companyName === "string" && item.companyName.trim())
    .map((item) => ({
      companyName: item.companyName.trim(),
      contactPerson: item.contactPerson?.trim() || undefined,
      email: item.email?.trim() || undefined,
      phone: item.phone?.trim() || undefined,
      altPhone: item.altPhone?.trim() || undefined,
      address: item.address?.trim() || undefined,
      notes: item.notes?.trim() || undefined,
    }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function parseContactSheet(
  buffer: Buffer,
  mimeType: string,
  fileName: string
): Promise<ParsedContact[]> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const isPDF =
    mimeType === "application/pdf" ||
    mimeType === "application/x-pdf" ||
    ext === "pdf";

  if (isPDF) {
    return parsePDF(buffer);
  }

  // CSV or Excel
  return parseSpreadsheet(buffer);
}
