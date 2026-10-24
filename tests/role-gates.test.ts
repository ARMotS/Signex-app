/**
 * Office routes gate on requireOffice(ctx), not requireRole(ctx, "ADMIN",
 * "SUPER_ADMIN"). The old form still compiles and still keeps drivers out, so
 * nothing else would notice a new route written that way — but it would
 * silently refuse a COMPANY_ADMIN working in an allocated branch.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
}

describe("office role gates", () => {
  it("no route uses the ADMIN + SUPER_ADMIN pair instead of requireOffice", () => {
    const offenders = [...walk("app"), ...walk("lib")]
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /requireRole\(\s*ctx\s*,\s*["']ADMIN["']\s*,\s*["']SUPER_ADMIN["']\s*\)/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
