/**
 * sheet-filename.ts
 * The sheet number in an exported file's name.
 *
 * The client's Trip application does not print the sheet number inside a
 * courier trip sheet — it names the file after it: `cts-200189-p5.xlsx`
 * (prefix, sheet number, branch). Trip sheets follow the same shape
 * (`ts-102371-p5.xls`). Files also arrive renamed by people and by browsers,
 * so the reader accepts the shapes they turn into, strongest first:
 *
 *   1. prefixed      cts-200189-p5, CTS 200189, cts_200189_p5, CTS200189_SAMPLE-CUSTOMER
 *                    (Signex's own stored name), Courier Trip Sheet No. 200189,
 *                    ts-102371-p5, TS102371
 *   2. leading       200189-p5, 200189 Sample customer
 *   3. only number   the one run of 4+ digits left once dates, copy counters
 *                    and branch codes are set aside: "export 22-10-2026 200189"
 *
 * Two candidate numbers and no prefix to choose between them is no answer —
 * a guessed sheet number would file one customer's goods under another sheet.
 *
 * No imports, so the mapping wizard can show the same reading in the browser.
 */

export interface SheetFilename {
  /** The sheet number, digits only, as written (leading zeros kept). */
  number: string;
  /** The branch code after the number (p5, j12, c2), lowercase, if any. */
  branch: string | null;
  /** What the prefix says the file is, if it has one. */
  kind: "COURIER_TRIP_SHEET" | "TRIP_SHEET" | null;
  convention: "prefixed" | "leading" | "only-number";
}

const SEP = "[\\s_.#-]*";
const NUMBER = "(\\d{4,10})(?!\\d)";
const BRANCH = "(?:[\\s_-]+([a-z]{1,3}\\d{1,3})(?![a-z\\d]))?";

// Longest first, so "courier trip sheet" is not read as "courier".
const PREFIXES: { pattern: string; kind: SheetFilename["kind"] }[] = [
  { pattern: `courier${SEP}trip${SEP}sheet`, kind: "COURIER_TRIP_SHEET" },
  { pattern: `trip${SEP}sheet`, kind: "TRIP_SHEET" },
  { pattern: "cts", kind: "COURIER_TRIP_SHEET" },
  { pattern: "courier", kind: "COURIER_TRIP_SHEET" },
  { pattern: "ts", kind: "TRIP_SHEET" },
];

const PREFIXED = PREFIXES.map(({ pattern, kind }) => ({
  kind,
  regex: new RegExp(`^${pattern}${SEP}(?:no\\.?|num(?:ber)?)?${SEP}${NUMBER}${BRANCH}`, "i"),
}));

const LEADING = new RegExp(`^${NUMBER}${BRANCH}(?:[\\s_-]|$)`, "i");

/** A filename without its folder or extension: "ts-102371-p5.xls" → "ts-102371-p5". */
export function filenameStem(filename: string): string {
  const base = String(filename ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** What a browser or a person adds to a name: "Copy of …", " (2)", " - Copy". */
function stripCopyMarks(stem: string): string {
  return stem
    .replace(/^copy\s+of\s+/i, "")
    .replace(/\s*-\s*copy(?:\s*\(\d+\))?$/i, "")
    .replace(/\s*\(\d{1,3}\)$/, "")
    .trim();
}

// Dates are digits too. Set aside before looking for a lone number:
// 2026-10-22, 22-10-2026, 22.10.26, 20261022.
const DATES = [
  /(?<!\d)(?:19|20)\d{2}[-_.\/](?:0?[1-9]|1[0-2])[-_.\/](?:0?[1-9]|[12]\d|3[01])(?!\d)/g,
  /(?<!\d)(?:0?[1-9]|[12]\d|3[01])[-_.\/](?:0?[1-9]|1[0-2])[-_.\/](?:(?:19|20)\d{2}|\d{2})(?!\d)/g,
  /(?<!\d)(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?!\d)/g,
];

/** The sheet number in a file's name, or null when there is none to be sure of. */
export function readSheetFilename(filename: string): SheetFilename | null {
  const stem = stripCopyMarks(filenameStem(filename));
  if (!stem) return null;

  for (const { kind, regex } of PREFIXED) {
    const m = regex.exec(stem);
    if (m) return { number: m[1], branch: m[2]?.toLowerCase() ?? null, kind, convention: "prefixed" };
  }

  const leading = LEADING.exec(stem);
  if (leading) {
    return { number: leading[1], branch: leading[2]?.toLowerCase() ?? null, kind: null, convention: "leading" };
  }

  let rest = stem;
  for (const date of DATES) rest = rest.replace(date, " ");
  const candidates = rest.match(/(?<!\d)\d{4,10}(?!\d)/g) ?? [];
  // A bare four-digit year is not a sheet number.
  const numbers = candidates.filter((n) => !(n.length === 4 && /^(?:19|20)\d{2}$/.test(n)));
  if (numbers.length === 1) {
    return { number: numbers[0], branch: null, kind: null, convention: "only-number" };
  }
  return null;
}
