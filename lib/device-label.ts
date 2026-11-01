/**
 * How a signed-in device is named on screen and in the audit log:
 * "Chrome on Android", "Windows desktop", "Phone". No imports: the devices
 * page uses it in the browser.
 */
export function deviceLabel(d: { browser: string | null; os: string | null; deviceType: string | null }): string {
  if (d.browser && d.os) return `${d.browser} on ${d.os}`;
  if (d.browser) return d.browser;
  if (d.os) return `${d.os} ${d.deviceType ?? "device"}`;
  if (d.deviceType) return d.deviceType[0].toUpperCase() + d.deviceType.slice(1);
  return "Unknown device";
}
