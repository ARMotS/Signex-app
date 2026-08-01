/**
 * SheetJS API compatibility guard.
 *
 * xlsx is pinned to a tarball from cdn.sheetjs.com rather than npm, because the
 * npm-published 0.18.5 carries an unfixed prototype-pollution and ReDoS advisory
 * and SheetJS no longer publishes there. That makes version changes manual and
 * easy to get wrong, so this pins down the exact call sequence
 * lib/trip-parser.ts depends on:
 *
 *   XLSX.read(buffer, { type: "buffer" })
 *     → workbook.SheetNames[0]
 *     → workbook.Sheets[name]
 *     → XLSX.utils.sheet_to_json(sheet, { header: 1 })
 *
 * If a future build changes any of that, this fails here rather than silently
 * on a real trip sheet at 6am.
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

/** A workbook shaped like a real trip sheet. */
function buildTripSheetBuffer(rows: (string | number)[][]): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

const HEADER = ["Date", "Driver", "REGNO", "Customer", "INVOICENO", "NOP"];

describe("SheetJS read path used by the trip parser", () => {
  it("round-trips a trip sheet through the exact parser call sequence", () => {
    const buffer = buildTripSheetBuffer([
      HEADER,
      ["2026-07-30", "John Smith", "CA 123-456", "Acme Ltd", "INV-2041", 3],
      ["2026-07-30", "John Smith", "CA 123-456", "Beta Co", "INV-2042", 1],
    ]);

    const workbook = XLSX.read(buffer, { type: "buffer" });
    expect(workbook.SheetNames.length).toBeGreaterThan(0);

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1 });

    expect(data).toHaveLength(3);
    expect(data[0]).toEqual(HEADER);
    expect(data[1][1]).toBe("John Smith");
    expect(data[1][4]).toBe("INV-2041");
  });

  it("keeps numeric cells numeric, so parcel counts survive parseInt", () => {
    const buffer = buildTripSheetBuffer([HEADER, ["2026-07-30", "A", "B", "C", "INV-1", 7]]);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const data = XLSX.utils.sheet_to_json<(string | number)[]>(
      workbook.Sheets[workbook.SheetNames[0]],
      { header: 1 }
    );

    expect(data[1][5]).toBe(7);
    // The parser stringifies every cell before use; that must not corrupt it.
    expect(parseInt(String(data[1][5]))).toBe(7);
  });

  it("emits header:1 rows as arrays, not keyed objects", () => {
    // The parser indexes rows positionally via its detected column map, so a
    // change to object output would break every sheet silently.
    const buffer = buildTripSheetBuffer([HEADER, ["d", "dr", "r", "c", "INV-9", 1]]);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      header: 1,
    });

    expect(Array.isArray(data[0])).toBe(true);
  });

  it("is running a build that carries the security fixes", () => {
    // 0.20.x is the first line with the prototype-pollution and ReDoS fixes.
    const [major, minor] = String(XLSX.version).split(".").map(Number);
    expect(major > 0 || minor >= 20).toBe(true);
  });
});
