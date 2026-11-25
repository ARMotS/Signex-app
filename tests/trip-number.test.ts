import { describe, it, expect } from "vitest";
import {
  exampleManualTripNumber,
  formatManualTripNumber,
  isManualTripNumber,
  readBranchCode,
} from "@/lib/trip-number-format";
import { saDayKey } from "@/lib/sa-time";
import { readCourierCompanyInput } from "@/lib/courier-company-input";

describe("manual trip numbers", () => {
  it("takes the Johannesburg day, not the server's", () => {
    expect(saDayKey(new Date("2026-11-24T21:59:00Z"))).toBe("261124");
    expect(saDayKey(new Date("2026-11-24T22:00:00Z"))).toBe("261125");
    expect(saDayKey(new Date("2026-01-01T00:00:00Z"))).toBe("260101");
  });

  it("formats with and without a branch code, the sequence padded to two", () => {
    expect(formatManualTripNumber("P5", "261125", 1)).toBe("SX-P5-261125-01");
    expect(formatManualTripNumber("", "261125", 12)).toBe("SX-261125-12");
    expect(formatManualTripNumber(null, "261125", 100)).toBe("SX-261125-100");
    expect(exampleManualTripNumber("J12", new Date("2026-11-25T08:00:00Z"))).toBe("SX-J12-261125-01");
  });

  it("recognises its own numbers and nothing the Trip program names", () => {
    expect(isManualTripNumber("SX-P5-261125-01")).toBe(true);
    expect(isManualTripNumber("SX-261125-01")).toBe(true);
    for (const name of ["ts-102371-p5.xls", "cts-200189-p5.xlsx", "SX-261125-01.xls", "SX-P5-2611-01", "", null]) {
      expect(isManualTripNumber(name)).toBe(false);
    }
  });

  it("validates the branch code: letters and digits, up to six, uppercase", () => {
    expect(readBranchCode("p5")).toEqual({ ok: true, value: "P5" });
    expect(readBranchCode(" p-5 ")).toEqual({ ok: true, value: "P5" });
    expect(readBranchCode("")).toEqual({ ok: true, value: "" });
    expect(readBranchCode(undefined)).toEqual({ ok: true, value: "" });
    expect(readBranchCode("P5!").ok).toBe(false);
    expect(readBranchCode("ABCDEFG").ok).toBe(false);
    expect(readBranchCode("ABCDEF")).toEqual({ ok: true, value: "ABCDEF" });
  });
});

describe("courier company fields", () => {
  it("needs a name and keys it the way courier sheets compare companies", () => {
    const read = readCourierCompanyInput({ name: "  Dawn  Wing & Co ", email: " ops@dawnwing.co.za " });
    expect(read).toEqual({
      ok: true,
      value: {
        name: "Dawn Wing & Co",
        nameKey: "dawn wing and co",
        contactPerson: null,
        phone: null,
        email: "ops@dawnwing.co.za",
        accountNumber: null,
        notes: null,
      },
    });
    expect(readCourierCompanyInput({ name: " " }).ok).toBe(false);
    expect(readCourierCompanyInput({ name: "!!!" }).ok).toBe(false);
    expect(readCourierCompanyInput({ name: "X", email: "nope" }).ok).toBe(false);
    expect(readCourierCompanyInput({ name: "X".repeat(81) }).ok).toBe(false);
  });

  it("on an edit, changes only the fields sent and keeps line breaks in notes", () => {
    expect(readCourierCompanyInput({ notes: " Cut-off 15:00\nDepot B " }, { partial: true })).toEqual({
      ok: true,
      value: { notes: "Cut-off 15:00\nDepot B" },
    });
    expect(readCourierCompanyInput({ phone: "" }, { partial: true })).toEqual({ ok: true, value: { phone: null } });
  });
});
