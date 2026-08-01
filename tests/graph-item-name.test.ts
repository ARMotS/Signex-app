/**
 * OneDrive filename safety.
 *
 * Invoice filenames arrive from a URL path parameter — `/api/invoices/[id]` —
 * and are then interpolated into a Microsoft Graph path address of the form
 * `/me/drive/items/{folderId}:/{filename}`. Graph treats "/" as a separator and
 * ".." as a parent, so an unsanitised name would let a caller walk out of the
 * invoice folder and read anywhere in that ADMIN's drive.
 *
 * The local-filesystem branch in lib/invoices.ts has its own traversal guard;
 * these cover the OneDrive half of the same rule.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";

// Stub the database layer so this stays a pure unit test — the module under
// test imports scopedPrisma to read the CloudAccount row.
vi.mock("@/lib/db-scoped", () => ({
  scopedPrisma: () => ({ cloudAccount: { findFirst: async () => null } }),
  UNSAFE_unscopedPrisma: {},
}));

let getInvoiceItemByName: (t: string, f: string) => Promise<unknown>;
let getSignedInvoiceItemByName: (t: string, f: string) => Promise<unknown>;

beforeAll(async () => {
  const mod = await import("@/lib/microsoft-graph");
  getInvoiceItemByName = mod.getInvoiceItemByName;
  getSignedInvoiceItemByName = mod.getSignedInvoiceItemByName;
});

/**
 * Build a name containing a control character.
 *
 * Constructed at runtime rather than written as a literal: a raw NUL or DEL
 * byte in a source file makes tools treat it as binary, and an escape sequence
 * is easy to mangle on a later edit. This keeps the file plain ASCII.
 */
const withControlChar = (code: number) =>
  `bad${String.fromCharCode(code)}name.pdf`;

/** Names that must never reach Graph as a path. */
const TRAVERSAL = [
  "../secrets.pdf",
  "../../Documents/payroll.pdf",
  "..",
  ".",
  "sub/folder.pdf",
  "sub\\folder.pdf",
  "",
  "   ",
  withControlChar(0), // NUL
  withControlChar(9), // TAB
  withControlChar(10), // LF
  withControlChar(13), // CR
  withControlChar(31), // unit separator
  withControlChar(127), // DEL
];

describe("invoice filename sanitisation", () => {
  it.each(TRAVERSAL)("rejects %j", async (name) => {
    await expect(getInvoiceItemByName("tenant-1", name)).rejects.toThrow(
      /path traversal/i
    );
  });

  it.each(TRAVERSAL)("rejects %j for signed invoices too", async (name) => {
    await expect(getSignedInvoiceItemByName("tenant-1", name)).rejects.toThrow(
      /path traversal/i
    );
  });

  it("allows ordinary invoice filenames", async () => {
    // No OneDrive account is configured in the stub, so a name that passes
    // validation resolves to null rather than throwing. Reaching null is the
    // signal that the guard let it through.
    for (const name of [
      "INV-2041.pdf",
      "IV-365-4.pdf",
      "Invoice 2041.pdf",
      "invoice#7.pdf",
      "Acme & Co - 2041.pdf",
      "facture-éàü.pdf",
    ]) {
      await expect(getInvoiceItemByName("tenant-1", name)).resolves.toBeNull();
    }
  });

  it("trims surrounding whitespace rather than rejecting it", async () => {
    await expect(getInvoiceItemByName("tenant-1", "  INV-1.pdf  ")).resolves.toBeNull();
  });
});
