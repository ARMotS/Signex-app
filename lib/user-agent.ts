/**
 * A coarse reading of a User-Agent header, for the devices list: which
 * browser, which operating system, phone / tablet / desktop.
 *
 * Deliberately small and dependency-free. It labels a device for a person
 * looking at a list; nothing is authorised on it, and a user agent is
 * whatever the client chose to send. ua-parser-js was not used because its
 * current major version is AGPL.
 *
 * No imports, so it can run in the browser too.
 */

export type DeviceType = "phone" | "tablet" | "desktop";

export interface DeviceDescription {
  browser: string | null;
  os: string | null;
  deviceType: DeviceType | null;
}

/** Longest header kept; anything past it is noise or abuse. */
export const MAX_USER_AGENT_LENGTH = 500;

function major(ua: string, pattern: RegExp): string | null {
  const m = ua.match(pattern);
  return m ? m[1] : null;
}

function withVersion(name: string, version: string | null): string {
  return version ? `${name} ${version}` : name;
}

function readBrowser(ua: string): string | null {
  // Order matters: Edge, Samsung Internet and Opera all also say "Chrome",
  // and every browser on iOS says "Safari".
  const rules: [string, RegExp][] = [
    ["Edge", /\bEdg(?:e|A|iOS)?\/(\d+)/],
    ["Samsung Internet", /\bSamsungBrowser\/(\d+)/],
    ["Opera", /\b(?:OPR|OPiOS)\/(\d+)/],
    ["Firefox", /\b(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /\b(?:Chrome|CriOS)\/(\d+)/],
  ];
  for (const [name, pattern] of rules) {
    const version = major(ua, pattern);
    if (version) return withVersion(name, version);
  }
  if (/\bSafari\//.test(ua) && /\bVersion\/(\d+)/.test(ua)) {
    return withVersion("Safari", major(ua, /\bVersion\/(\d+)/));
  }
  return null;
}

function readOs(ua: string): string | null {
  const android = ua.match(/\bAndroid\s+(\d+)/);
  if (android) return `Android ${android[1]}`;
  if (/\bAndroid\b/.test(ua)) return "Android";

  const ios = ua.match(/\b(?:iPhone|iPad|iPod)\b.*?\bOS (\d+)[_.]/);
  if (ios) return /\biPad\b/.test(ua) ? `iPadOS ${ios[1]}` : `iOS ${ios[1]}`;
  if (/\b(?:iPhone|iPod)\b/.test(ua)) return "iOS";
  if (/\biPad\b/.test(ua)) return "iPadOS";

  // NT 10.0 is reported by both Windows 10 and 11, so no number is claimed.
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macOS";
  if (/\bLinux\b/.test(ua)) return "Linux";
  return null;
}

function readDeviceType(ua: string, os: string | null): DeviceType | null {
  if (/\biPad\b|\bTablet\b/.test(ua)) return "tablet";
  // An Android tablet leaves "Mobile" out; a phone puts it in.
  if (/\bAndroid\b/.test(ua)) return /\bMobile\b/.test(ua) ? "phone" : "tablet";
  if (/\biPhone\b|\biPod\b|\bMobile\b/.test(ua)) return "phone";
  return os ? "desktop" : null;
}

export function describeUserAgent(raw: string | null | undefined): DeviceDescription {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { browser: null, os: null, deviceType: null };
  }
  const ua = raw.slice(0, MAX_USER_AGENT_LENGTH);
  const os = readOs(ua);
  return { browser: readBrowser(ua), os, deviceType: readDeviceType(ua, os) };
}
