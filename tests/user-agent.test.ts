/**
 * The devices list's reading of a User-Agent header. Coarse on purpose — a
 * label for a person, never an authorisation input.
 */

import { describe, it, expect } from "vitest";
import { describeUserAgent } from "@/lib/user-agent";

const UA = {
  chromeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68",
  chromeAndroidPhone:
    "Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36",
  samsungAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  ipad:
    "Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
};

describe("describeUserAgent", () => {
  it.each([
    ["chromeWindows", "Chrome 130", "Windows", "desktop"],
    ["edgeWindows", "Edge 130", "Windows", "desktop"],
    ["chromeAndroidPhone", "Chrome 130", "Android 14", "phone"],
    ["samsungAndroid", "Samsung Internet 26", "Android 13", "phone"],
    ["androidTablet", "Chrome 130", "Android 13", "tablet"],
    ["safariIphone", "Safari 17", "iOS 17", "phone"],
    ["chromeIphone", "Chrome 130", "iOS 17", "phone"],
    ["ipad", "Safari 16", "iPadOS 16", "tablet"],
    ["safariMac", "Safari 18", "macOS", "desktop"],
    ["firefoxLinux", "Firefox 131", "Linux", "desktop"],
  ] as const)("reads %s", (key, browser, os, deviceType) => {
    expect(describeUserAgent(UA[key])).toEqual({ browser, os, deviceType });
  });

  it("says nothing rather than guessing when there is no header", () => {
    expect(describeUserAgent(null)).toEqual({ browser: null, os: null, deviceType: null });
    expect(describeUserAgent("   ")).toEqual({ browser: null, os: null, deviceType: null });
  });

  it("leaves what it cannot read null", () => {
    expect(describeUserAgent("curl/8.4.0")).toEqual({ browser: null, os: null, deviceType: null });
  });
});
