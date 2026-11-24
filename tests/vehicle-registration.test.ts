import { describe, it, expect } from "vitest";
import {
  cleanRegistration,
  licenceDiscState,
  readVehicleInput,
  vehicleRegistrationKey,
} from "@/lib/vehicle-registration";

describe("vehicleRegistrationKey", () => {
  it("ignores case, spaces, dashes and other separators", () => {
    for (const reg of ["CA 123-456", "ca123456", "CA-123-456", " ca 123 456 ", "CA.123/456"]) {
      expect(vehicleRegistrationKey(reg)).toBe("CA123456");
    }
  });

  it("is empty for blank or non-string input, so nothing links", () => {
    expect(vehicleRegistrationKey("")).toBe("");
    expect(vehicleRegistrationKey(" - ")).toBe("");
    expect(vehicleRegistrationKey(null)).toBe("");
    expect(vehicleRegistrationKey(42)).toBe("");
  });

  it("keeps letters and digits in order (a different plate stays different)", () => {
    expect(vehicleRegistrationKey("CA 123-456")).not.toBe(vehicleRegistrationKey("CA 123-465"));
  });
});

describe("cleanRegistration", () => {
  it("keeps the typed separators for display, uppercased", () => {
    expect(cleanRegistration("  ca  123-456 ")).toBe("CA 123-456");
  });
});

describe("readVehicleInput", () => {
  it("requires a registration with a letter or digit", () => {
    expect(readVehicleInput({})).toMatchObject({ ok: false });
    expect(readVehicleInput({ registration: " -- " })).toMatchObject({ ok: false });
  });

  it("cleans every field and treats blanks as none", () => {
    const res = readVehicleInput({
      registration: "gp 77 xy",
      make: "  Toyota ",
      model: "",
      type: "Bakkie",
      licenceDiscExpiry: "",
    });
    expect(res).toEqual({
      ok: true,
      value: {
        registration: "GP 77 XY",
        registrationKey: "GP77XY",
        make: "Toyota",
        model: null,
        type: "Bakkie",
        licenceDiscExpiry: null,
      },
    });
  });

  it("refuses an impossible date and an over-long registration", () => {
    expect(readVehicleInput({ registration: "A1", licenceDiscExpiry: "2026-02-30" })).toMatchObject({ ok: false });
    expect(readVehicleInput({ registration: "A1", licenceDiscExpiry: "next week" })).toMatchObject({ ok: false });
    expect(readVehicleInput({ registration: "A".repeat(21) })).toMatchObject({ ok: false });
  });

  it("on an edit, changes only the fields sent", () => {
    expect(readVehicleInput({ make: "Isuzu" }, { partial: true })).toEqual({ ok: true, value: { make: "Isuzu" } });
    expect(readVehicleInput({ licenceDiscExpiry: null }, { partial: true })).toEqual({
      ok: true,
      value: { licenceDiscExpiry: null },
    });
  });
});

describe("licenceDiscState", () => {
  const today = "2026-11-24";
  it("is valid through its expiry date", () => {
    expect(licenceDiscState("2026-11-24", today)).toBe("expiring");
    expect(licenceDiscState("2026-11-23", today)).toBe("expired");
  });

  it("warns within 30 days, not before", () => {
    expect(licenceDiscState("2026-12-24", today)).toBe("expiring");
    expect(licenceDiscState("2026-12-25", today)).toBe("ok");
  });

  it("is none without a date", () => {
    expect(licenceDiscState(null, today)).toBe("none");
  });
});
