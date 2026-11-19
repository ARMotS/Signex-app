/**
 * Times a person reads are South African, whatever the server's clock says.
 *
 * The server runs on UTC, so a signature given at 09:35 was printed on the
 * signed invoice (and in the customer's email) as 07:35. The formatter is
 * checked under several process time zones, and server code is scanned for a
 * bare clock-dependent format coming back.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { formatSaDateTime } from "@/lib/sa-time";

describe("formatSaDateTime", () => {
  const original = process.env.TZ;
  afterEach(() => {
    process.env.TZ = original;
  });

  it("prints Johannesburg time, not UTC", () => {
    // Two Electro City JHB invoices signed 09:35 SAST were stamped 07:35.
    expect(formatSaDateTime(new Date("2026-11-19T07:35:00Z"))).toBe("19 Nov 2026, 09:35");
  });

  it("does not depend on the server's time zone", () => {
    const at = new Date("2026-11-19T07:35:00Z");
    const seen = ["UTC", "America/New_York", "Asia/Tokyo", "Africa/Johannesburg"].map((tz) => {
      process.env.TZ = tz;
      return formatSaDateTime(at);
    });
    expect(new Set(seen)).toEqual(new Set(["19 Nov 2026, 09:35"]));
  });

  it("rolls the date over at South African midnight", () => {
    expect(formatSaDateTime(new Date("2026-11-19T22:30:00Z"))).toBe("20 Nov 2026, 00:30");
    expect(formatSaDateTime(new Date("2026-12-31T21:59:00Z"))).toBe("31 Dec 2026, 23:59");
    expect(formatSaDateTime(new Date("2026-12-31T22:00:00Z"))).toBe("01 Jan 2027, 00:00");
  });

  it("uses fixed month names", () => {
    expect(formatSaDateTime(new Date("2026-09-05T10:00:00Z"))).toBe("05 Sep 2026, 12:00");
  });
});

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
}

/** The text of the call's argument list, from the "(" at `open`. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Browser-only files, which mean the viewer's own clock on purpose. */
const VIEWER_CLOCK = new Set(["lib/relative-time.ts", "lib/record-filter.ts", "lib/day-window.ts"]);

describe("server code never prints a time on the server's clock", () => {
  const files = [...walk("lib"), ...walk("app/api"), ...walk("emails")]
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => !VIEWER_CLOCK.has(f));

  it("no toLocale*String with an hour and no timeZone", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/\.toLocale(?:Time)?String\(/g)) {
        const args = argsAt(src, m.index! + m[0].length - 1);
        const timeOfDay = /\bhour\b/.test(args) || /toLocaleTimeString/.test(m[0]);
        if (timeOfDay && !/\btimeZone\b/.test(args)) offenders.push(`${f}: ${m[0]}${args.slice(1, 60)}`);
      }
    }
    expect(offenders, "use formatSaDateTime (lib/sa-time.ts)").toEqual([]);
  });

  it("no date-fns or getHours/getMinutes on the server (both read the server's zone)", () => {
    const offenders = files.filter((f) => {
      const src = fs.readFileSync(f, "utf8");
      return /from\s+["']date-fns["']/.test(src) || /\.get(?:Hours|Minutes)\(/.test(src);
    });
    expect(offenders, "use formatSaDateTime (lib/sa-time.ts)").toEqual([]);
  });
});
