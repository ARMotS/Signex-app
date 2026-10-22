/**
 * Invoice numbers, as the different documents write them.
 *
 * The invoice PDF prints INV-2026-1047 (or IV-1047-2026, or IV-365-4), while
 * the trip sheet, the collection sheet and the credit note print 1047. Every
 * match between those documents goes through this module, so they only have
 * to agree on the number — never on the decoration around it.
 *
 * Pure on purpose: no imports. The Settings page runs the same functions in the
 * browser to preview a tenant's custom pattern against sample numbers, so what
 * the dispatcher sees there is exactly what the server will do.
 */

// ─── Built-in rule ────────────────────────────────────────────────────────

/**
 * Prefixes written in front of the number, on the sheet or in the filename:
 * IV-365, INV-365, INV/2026/1047, INVOICE-365, INVOICE 365, Invoice # 365,
 * Invoice No. 365, Tax Invoice 365, SI-365, SINV365. Only stripped when digits
 * follow, so an alphanumeric invoice number that merely starts with these
 * letters survives.
 */
const INVOICE_PREFIX =
  /^(?:TAX\s*INVOICE|INVOICE|INV|IV|SINV|SI)\s*(?:NO\.?|NUMBER|NUM\.?)?\s*[#:]?[\s\-_.#:/]*(?=\d)/;

/** Marks a duplicated file rather than a different invoice: "IV-365-4 (1)", "INV-365 copy". */
const COPY_SUFFIX = /(?:\s*\(\d+\)|[\s_\-]*COPY(?:\s*\d+)?)$/i;

const SEPARATORS = /[\s\-_./]/g;
const SEPARATOR_RUN = /[\s\-_./]+/;

/** Only 19xx/20xx reads as a year; any other 4-digit part is part of the number. */
const isYear = (part: string) => /^(?:19|20)\d{2}$/.test(part);

/** A 1–3 digit tail is a page/copy counter: the 4 in IV-365-4. */
const isCounter = (part: string) => /^\d{1,3}$/.test(part);

/** Strip .pdf, a duplicate-copy marker and surrounding space. Case is kept. */
function stripFileDecoration(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/\.pdf$/i, "")
    .trim()
    .replace(COPY_SUFFIX, "")
    .trim();
}

/**
 * The number inside a two- or three-part value, with the year or copy counter
 * taken off. Null when the value is not made of such parts.
 *
 *   365-4          → 365    trailing copy counter
 *   1010-2026      → 1010   trailing year
 *   2026-1047      → 1047   leading year (the number must then be 4+ digits)
 *   2026-1047-2    → 1047   leading year and a copy counter
 *
 * When BOTH parts read as a year (IV-1950-2026, INV-2026-1950) the one nearer
 * the current year is taken as the year: an invoice is filed under the year it
 * was raised, and invoice numbers pass through 1900–2099 long before the
 * calendar does. Equally near (2025-2027 in 2026) keeps the old rule — the
 * trailing part is the year. A tenant whose numbers really are ambiguous sets
 * a custom pattern instead.
 *
 * A leading year with a 1–3 digit tail (2026-4) stays "invoice 2026, copy 4",
 * as it always has.
 */
function builtInBase(value: string): string | null {
  const parts = value.split(SEPARATOR_RUN);
  if (parts.length === 3 && isYear(parts[0]) && isCounter(parts[2])) parts.pop();
  if (parts.length !== 2 || !parts.every((p) => /^\d+$/.test(p))) return null;

  const [first, second] = parts;

  if (isCounter(second)) return first;

  if (isYear(first) && isYear(second)) {
    const now = new Date().getUTCFullYear();
    const firstIsNearer = Math.abs(now - Number(first)) < Math.abs(now - Number(second));
    return firstIsNearer ? second : first;
  }
  if (isYear(second)) return first;
  if (isYear(first) && second.length >= 4) return second;

  return null;
}

// ─── Tenant pattern ───────────────────────────────────────────────────────

/** A tenant's compiled custom pattern, or null for the built-in rule. */
export type InvoiceNoPattern = RegExp | null;

export const INVOICE_NO_PATTERN_MAX_LENGTH = 200;

/**
 * Inputs longer than this skip a custom pattern and use the built-in rule.
 * Invoice numbers and their filenames are short; the cap bounds what an
 * ADMIN-written regex can be made to chew on, server-side, for every tenant.
 */
const PATTERN_INPUT_MAX_LENGTH = 64;

/**
 * Validate and compile an ADMIN's pattern. Empty means "use the built-in rule".
 *
 * The pattern runs on the server against every filename in the invoice folder,
 * on an instance other tenants share, so it is restricted to shapes that
 * cannot backtrack exponentially: no backreferences and no repeated group —
 * `(\d+)+`, `(a|b)*`, `(...){2,}`. A single group with a quantifier INSIDE it,
 * which is all an invoice number needs, is fine: `INV-\d{4}-(\d+)`.
 *
 * The number is the group named `num` if there is one, else the first group.
 */
export function compileInvoiceNoPattern(
  source: string
): { ok: true; pattern: InvoiceNoPattern } | { ok: false; error: string } {
  const trimmed = String(source ?? "").trim();
  if (!trimmed) return { ok: true, pattern: null };

  if (trimmed.length > INVOICE_NO_PATTERN_MAX_LENGTH) {
    return { ok: false, error: `Keep the pattern under ${INVOICE_NO_PATTERN_MAX_LENGTH} characters.` };
  }
  const unsafe = unsafePatternReason(trimmed);
  if (unsafe) return { ok: false, error: unsafe };

  let pattern: RegExp;
  try {
    pattern = new RegExp(trimmed, "i");
  } catch (err) {
    return { ok: false, error: `Not a valid pattern: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Appending an empty alternative makes the pattern match "", which reports
  // how many capture groups it has.
  const groups = new RegExp(`${trimmed}|`).exec("")!.length - 1;
  if (groups < 1) {
    return { ok: false, error: "Put brackets around the invoice number, e.g. INV-\\d{4}-(\\d+)." };
  }

  return { ok: true, pattern };
}

/**
 * Why an ADMIN-written pattern is refused, or null if its shape is safe to run
 * server-side: no backreferences and no repeated group. Shared with import
 * templates (lib/sheet-mapping.ts), whose patterns run on the same instance.
 */
export function unsafePatternReason(source: string): string | null {
  if (/\\[1-9]|\\k</.test(source)) {
    return "Backreferences (\\1, \\k<name>) are not supported.";
  }
  if (/\)\s*[*+{]/.test(source)) {
    return "A group cannot be repeated — put the quantifier inside it: (\\d+), not (\\d)+.";
  }
  return null;
}

/** The digits a custom pattern pulls out of a value, or null if it does not match. */
function patternBase(raw: string, pattern: RegExp): string | null {
  const value = stripFileDecoration(raw);
  if (!value || value.length > PATTERN_INPUT_MAX_LENGTH) return null;

  const match = pattern.exec(value);
  if (!match) return null;
  const captured = match.groups?.num ?? match[1] ?? "";
  return captured.replace(/\D/g, "") || null;
}

// ─── Match keys ───────────────────────────────────────────────────────────

/**
 * The keys an invoice number is matched on, strongest first. The same function
 * runs on the INVOICENO cell and on the PDF's filename stem, so the two only
 * have to agree on one key:
 *
 *   0. exact     — prefix and separators removed      IV-365-4 → 3654
 *   1. base      — year / copy counter dropped        IV-365-4 → 365, INV-2026-1047 → 1047
 *   2. digits    — every non-digit removed            ABC/365  → 365
 *   3. unpadded  — leading zeros dropped              IV-000365 → 365
 *
 * The base key comes from the tenant's custom pattern when it matches the
 * value, else from the built-in rule (see builtInBase). A pattern that does
 * not match — the bare "1047" on a sheet, say — falls back rather than failing,
 * so a pattern only has to describe the decorated form.
 *
 * Exact keys are tried first, so two files that differ only in a trailing
 * counter (IV-365-4, IV-365-5) each still match their own exact number.
 */
export function invoiceMatchKeys(
  raw: string,
  pattern: InvoiceNoPattern = null
): [string, string | null, string | null, string | null] {
  const value = stripFileDecoration(raw).toUpperCase().replace(INVOICE_PREFIX, "").trim();

  const exact = value.replace(SEPARATORS, "");
  const base = (pattern && patternBase(raw, pattern)) ?? builtInBase(value);
  const digits = exact.replace(/\D/g, "") || null;
  const unpadded = (base ?? digits)?.replace(/^0+(?=\d)/, "") ?? null;

  return [exact, base, digits, unpadded];
}

/**
 * The invoice number every document is matched on: digits only, prefix, year
 * and copy counter stripped, leading zeros dropped. Stored beside the raw value
 * as `invoiceNoNormalized`; the raw value is what is displayed.
 *
 *   INV-2026-1047 → 1047    IV-1047-2026 → 1047    inv 1047 → 1047
 *   IV-365-4      → 365     Invoice # 001 → 1
 *
 * "" when the value carries no digits at all.
 */
export function normalizeInvoiceNo(raw: string, pattern: InvoiceNoPattern = null): string {
  return invoiceMatchKeys(raw, pattern)[3] ?? "";
}

/** As normalizeInvoiceNo, but null for a blank value — the shape the DB column takes. */
export function normalizedInvoiceNoOrNull(
  raw: string | null | undefined,
  pattern: InvoiceNoPattern = null
): string | null {
  return raw ? normalizeInvoiceNo(raw, pattern) || null : null;
}

/**
 * Index files by every match key. Each tier is registered for all files before
 * the next, so an exact key is never shadowed by another file's looser one.
 *
 * @param maxTier Highest key tier to use (see invoiceMatchKeys).
 */
export function buildInvoiceLookup(
  files: { filename: string; invoiceNumber: string }[],
  maxTier = 3,
  pattern: InvoiceNoPattern = null
): Map<string, string> {
  const lookup = new Map<string, string>();
  const keyed = files.map((f) => ({ filename: f.filename, keys: invoiceMatchKeys(f.invoiceNumber, pattern) }));

  for (let tier = 0; tier <= maxTier; tier++) {
    for (const { filename, keys } of keyed) {
      const key = keys[tier];
      if (key && !lookup.has(key)) lookup.set(key, filename);
    }
  }
  return lookup;
}

/** The filename a sheet's invoice number resolves to, trying its keys strongest first. */
export function matchInvoiceFile(
  lookup: Map<string, string>,
  invoiceNumber: string,
  maxTier = 3,
  pattern: InvoiceNoPattern = null
): string | undefined {
  const keys = invoiceMatchKeys(invoiceNumber, pattern);
  for (let tier = 0; tier <= maxTier; tier++) {
    const key = keys[tier];
    const hit = key ? lookup.get(key) : undefined;
    if (hit) return hit;
  }
  return undefined;
}
