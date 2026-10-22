/**
 * The courier folder's look (lib/courier-inbox.ts): which files are courier
 * sheets, and what one look does with each. The look end to end — reading,
 * importing, filing, and scoping — is in isolation.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  INBOX_FAILURE_RETRY_MS,
  INBOX_PER_LOOK,
  isCourierSheetFile,
  planInboxLook,
  type InboxFile,
} from "@/lib/courier-inbox";

const NOW = new Date("2026-10-22T10:00:00Z");
const file = (id: string, name = `cts-${id}-p5.xlsx`, lastModified = "2026-10-22T08:00:00Z"): InboxFile => ({
  id,
  name,
  lastModified,
});
const plan = (
  files: InboxFile[],
  opts: { imported?: string[]; failures?: [string, { lastModified: Date | null; updatedAt: Date }][]; force?: boolean } = {}
) =>
  planInboxLook({
    files,
    imported: new Set(opts.imported ?? []),
    failures: new Map(opts.failures ?? []),
    now: NOW,
    force: opts.force ?? false,
  });

describe("isCourierSheetFile", () => {
  it("takes the Trip application's Excel files and nothing else", () => {
    expect(isCourierSheetFile("cts-200189-p5.xlsx")).toBe(true);
    expect(isCourierSheetFile("CTS-200189-P5.XLS")).toBe(true);
    // Excel's lock file, synced while someone has the sheet open.
    expect(isCourierSheetFile("~$cts-200189-p5.xlsx")).toBe(false);
    expect(isCourierSheetFile(".cts-200189-p5.xlsx")).toBe(false);
    expect(isCourierSheetFile("cts-200189-p5.csv")).toBe(false);
    expect(isCourierSheetFile("notes.pdf")).toBe(false);
  });
});

describe("planInboxLook", () => {
  it("reads new sheets, oldest first, and passes over everything else", () => {
    const result = plan([
      file("2", undefined, "2026-10-22T09:00:00Z"),
      file("1", undefined, "2026-10-22T07:00:00Z"),
      file("lock", "~$cts-1-p5.xlsx"),
      file("pdf", "IV-1.pdf"),
    ]);
    expect(result.read.map((f) => f.id)).toEqual(["1", "2"]);
    expect(result.refile).toEqual([]);
  });

  it("files again a sheet already imported whose move did not finish — never imports it twice", () => {
    const result = plan([file("1"), file("2")], { imported: ["1"] });
    expect(result.refile.map((f) => f.id)).toEqual(["1"]);
    expect(result.read.map((f) => f.id)).toEqual(["2"]);
  });

  it("leaves a failed file alone until it changes, a while passes, or someone asks", () => {
    const failedAt = new Date(NOW.getTime() - 60_000);
    const failure: [string, { lastModified: Date; updatedAt: Date }] = [
      "1",
      { lastModified: new Date("2026-10-22T08:00:00Z"), updatedAt: failedAt },
    ];
    expect(plan([file("1")], { failures: [failure] }).read).toEqual([]);
    // Re-saved since it failed.
    expect(plan([file("1", undefined, "2026-10-22T09:30:00Z")], { failures: [failure] }).read).toHaveLength(1);
    // "Check folder".
    expect(plan([file("1")], { failures: [failure], force: true }).read).toHaveLength(1);
    // After the cool-down — a template may have been set up meanwhile.
    const old: [string, { lastModified: Date; updatedAt: Date }] = [
      "1",
      { lastModified: failure[1].lastModified, updatedAt: new Date(NOW.getTime() - INBOX_FAILURE_RETRY_MS) },
    ];
    expect(plan([file("1")], { failures: [old] }).read).toHaveLength(1);
  });

  it("forgets a failure once its file has left the folder", () => {
    const result = plan([file("1")], { failures: [["gone", { lastModified: null, updatedAt: NOW }]] });
    expect(result.gone).toEqual(["gone"]);
  });

  it("reads at most a handful per look", () => {
    const many = Array.from({ length: INBOX_PER_LOOK + 5 }, (_, i) => file(String(i), undefined, `2026-10-22T08:${String(i).padStart(2, "0")}:00Z`));
    expect(plan(many).read).toHaveLength(INBOX_PER_LOOK);
  });
});
