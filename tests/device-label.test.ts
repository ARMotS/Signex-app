import { describe, it, expect } from "vitest";
import { deviceLabel } from "@/lib/device-label";

describe("deviceLabel", () => {
  it("names a device by what is known about it", () => {
    expect(deviceLabel({ browser: "Chrome", os: "Android", deviceType: "phone" })).toBe("Chrome on Android");
    expect(deviceLabel({ browser: null, os: "Windows", deviceType: "desktop" })).toBe("Windows desktop");
    expect(deviceLabel({ browser: "Safari", os: null, deviceType: null })).toBe("Safari");
    expect(deviceLabel({ browser: null, os: null, deviceType: "phone" })).toBe("Phone");
    expect(deviceLabel({ browser: null, os: null, deviceType: null })).toBe("Unknown device");
  });
});
