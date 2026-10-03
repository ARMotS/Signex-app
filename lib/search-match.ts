/**
 * Text matching for the file lists on the Invoices and Trip Sheet pages.
 *
 * Both pages already hold their whole list in memory — the invoice folder and
 * the day's trip sheets each arrive in one response — so narrowing happens in
 * the browser and costs no round trip. Nothing here reads or writes data, so
 * there is no scope to thread through.
 *
 * The rules are the ones someone scanning a paper run sheet expects:
 *  - every word has to appear, in any order, across any of the fields, so
 *    "smith 4471" finds Smith's INV-4471 without anyone knowing which column
 *    holds which;
 *  - punctuation inside a reference is noise — "inv-4471", "inv 4471" and
 *    "INV4471" are the same search;
 *  - case never matters.
 *
 * Words match as substrings rather than prefixes: reading half an invoice
 * number off a delivery note is the common case.
 */

export type SearchField = string | number | null | undefined;

/** Non-alphanumerics removed, so "INV-4471" and "inv4471" compare equal. */
function squash(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

/**
 * Split a raw query into the words that must all match.
 *
 * Hoisted out of the match itself so a list tokenises once and then tests many
 * rows — the Trip Sheet page runs this across every stop of every sheet.
 */
export function tokenizeQuery(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True when every word in `tokens` appears somewhere in `fields`.
 *
 * An empty token list matches everything: an empty search box hides nothing.
 */
export function matchesTokens(tokens: string[], fields: SearchField[]): boolean {
  if (tokens.length === 0) return true;

  const present = fields
    .filter((f) => f !== null && f !== undefined && f !== "")
    .map(String);
  if (present.length === 0) return false;

  const haystack = present.join(" ").toLowerCase();
  // Squashed per field and only then joined: squashing the joined string would
  // delete the boundary between fields and let one word match across two of
  // them — a filename's tail plus a customer's head is not a match.
  const squashed = present.map(squash).join(" ");

  return tokens.every((token) => {
    if (haystack.includes(token)) return true;
    const bare = squash(token);
    return bare.length > 0 && squashed.includes(bare);
  });
}

/** One-off convenience wrapper — tokenises and matches in a single call. */
export function matchesQuery(query: string, ...fields: SearchField[]): boolean {
  return matchesTokens(tokenizeQuery(query), fields);
}
