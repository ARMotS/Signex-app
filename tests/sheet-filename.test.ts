/**
 * The sheet number in an export's filename (lib/sheet-filename.ts).
 *
 * The client's Trip application names a courier trip sheet `cts-200189-p5`
 * and a trip sheet `ts-102371-p5`: prefix, sheet number, branch. The rest of
 * this table is what those names become once a person or a browser has had
 * them — and the names it must refuse to guess at.
 */

import { describe, it, expect } from "vitest";
import { filenameStem, readSheetFilename } from "@/lib/sheet-filename";

const read = (name: string) => readSheetFilename(name);

describe("the client's own naming", () => {
  it("reads prefix, number and branch", () => {
    expect(read("cts-200189-p5.xlsx")).toEqual({
      number: "200189",
      branch: "p5",
      kind: "COURIER_TRIP_SHEET",
      convention: "prefixed",
    });
    expect(read("ts-102371-p5.xls")).toEqual({
      number: "102371",
      branch: "p5",
      kind: "TRIP_SHEET",
      convention: "prefixed",
    });
    expect(read("ts-102379-j12.xls")).toMatchObject({ number: "102379", branch: "j12" });
  });

  it("tells a trip sheet from a courier trip sheet by its prefix", () => {
    expect(read("cts-200189-p5.xlsx")?.kind).toBe("COURIER_TRIP_SHEET");
    expect(read("ts-200189-p5.xlsx")?.kind).toBe("TRIP_SHEET");
    expect(read("200189-p5.xlsx")?.kind).toBeNull();
  });
});

describe("other ways the same name arrives", () => {
  const cases: [string, string, string | null][] = [
    ["CTS-200189-P5.XLSX", "200189", "p5"],
    ["cts_200189_p5.xlsx", "200189", "p5"],
    ["CTS 200189 p5.xlsx", "200189", "p5"],
    ["cts200189.xlsx", "200189", null],
    ["CTS 200189.xlsx", "200189", null],
    ["CTS#200189.xlsx", "200189", null],
    ["cts-200189-p5 (1).xlsx", "200189", "p5"],
    ["cts-200189-p5 - Copy.xlsx", "200189", "p5"],
    ["Copy of cts-200189-p5.xlsx", "200189", "p5"],
    ["C:\\Users\\dispatch\\Downloads\\cts-200189-p5.xlsx", "200189", "p5"],
    ["Courier Trip Sheet 200189.xlsx", "200189", null],
    ["Courier Trip Sheet No. 200189.xlsx", "200189", null],
    ["courier_trip_sheet_200189_p5.xlsx", "200189", "p5"],
    ["Courier 200189.xlsx", "200189", null],
    // Signex's own name for a stored original — a customer slug may carry digits.
    ["CTS200189_AUTO-2000-PARTS.xlsx", "200189", null],
    ["Trip Sheet 102371.xls", "102371", null],
    ["TS102371.xls", "102371", null],
  ];

  for (const [name, number, branch] of cases) {
    it(name, () => {
      expect(read(name)).toMatchObject({ number, branch, convention: "prefixed" });
    });
  }
});

describe("no prefix", () => {
  it("reads a name that starts with the number", () => {
    expect(read("200189-p5.xlsx")).toMatchObject({ number: "200189", branch: "p5", convention: "leading" });
    expect(read("200189 Sample customer.xlsx")).toMatchObject({ number: "200189", branch: null, convention: "leading" });
    expect(read("200189.xlsx")).toMatchObject({ number: "200189", convention: "leading" });
  });

  it("reads the one number left once dates are set aside", () => {
    expect(read("export 22-10-2026 200189.xlsx")).toMatchObject({ number: "200189", convention: "only-number" });
    expect(read("export 2026-10-22 200189.xlsx")).toMatchObject({ number: "200189", convention: "only-number" });
    expect(read("sheet 200189 20261022.xlsx")).toMatchObject({ number: "200189", convention: "only-number" });
    expect(read("Customer 2026 sheet 200189.xlsx")).toMatchObject({ number: "200189", convention: "only-number" });
  });

  it("keeps leading zeros as written", () => {
    expect(read("cts-0200189.xlsx")?.number).toBe("0200189");
  });
});

describe("refuses to guess", () => {
  const none = [
    "sample courier trip sheet.xlsx",
    "courier trip sheet.xlsx",
    // Two numbers, nothing to choose between them.
    "waybill 700209 sheet 200189.xlsx",
    // A date is not a sheet number.
    "export 2026-10-22.xlsx",
    "22.10.26.xlsx",
    // Too short to be a sheet number; p5 is a branch.
    "cts-123-p5.xlsx",
    "p5.xlsx",
    "",
  ];
  for (const name of none) {
    it(JSON.stringify(name), () => {
      expect(read(name)).toBeNull();
    });
  }

  it("does not read a word that merely starts with a prefix", () => {
    // "ts" inside a word, then a number: only the lone-number rule applies.
    expect(read("tsunami 200189.xlsx")).toMatchObject({ number: "200189", kind: null, convention: "only-number" });
    expect(read("courierX 200189.xlsx")?.kind).toBeNull();
  });
});

describe("filenameStem", () => {
  it("strips only the folder and the last extension", () => {
    expect(filenameStem("ts-102371-p5.xls")).toBe("ts-102371-p5");
    expect(filenameStem("/a/b/run.v2.xlsx")).toBe("run.v2");
    expect(filenameStem("C:\\a\\b.xlsx")).toBe("b");
    expect(filenameStem(".hidden")).toBe(".hidden");
  });
});
