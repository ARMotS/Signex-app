/**
 * Where collection documents are looked for on a local collections folder.
 *
 * Reading only Pending/ made two ordinary arrangements look like an empty
 * folder: PDFs dropped straight into the collections folder, and the Pending
 * folder itself chosen as "the collections folder". Both must list, Signed/ must
 * not, and a folder the server cannot see must say so rather than read as empty.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let folder = "";

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(async () => ({ collectionsFolderPath: folder })),
}));

// No OneDrive collections folder: the local branch is the one under test.
vi.mock("@/lib/microsoft-graph", () => ({
  getOneDriveCollectionsSource: vi.fn(async () => null),
}));

import { listCollectionFolder, readCollectionDocument } from "@/lib/collections";

const TENANT = "tenant-1";

function write(rel: string, body = "%PDF-1.4 test") {
  const full = path.join(folder, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), "signex-collections-"));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

describe("listCollectionFolder (local)", () => {
  it("lists Pending/ and PDFs directly in the folder, never Signed/", async () => {
    write("Pending/COL-118.pdf");
    write("COL-119.pdf");
    write("Signed/COL-100_COLLECTED.pdf");
    write("notes.txt");

    const listing = await listCollectionFolder(TENANT);

    expect(listing.error).toBeUndefined();
    expect(listing.source).toBe("local");
    expect(listing.documents.map((d) => d.filename).sort()).toEqual(["COL-118.pdf", "COL-119.pdf"]);
  });

  it("prefers the Pending/ copy when the same name is in both places", async () => {
    write("Pending/COL-118.pdf", "%PDF-pending");
    write("COL-118.pdf", "%PDF-root");

    const listing = await listCollectionFolder(TENANT);
    expect(listing.documents).toHaveLength(1);

    const buffer = await readCollectionDocument(TENANT, "COL-118.pdf");
    expect(buffer?.toString()).toBe("%PDF-pending");
  });

  it("reads a document that sits in the folder root", async () => {
    write("COL-120.pdf", "%PDF-root");
    const buffer = await readCollectionDocument(TENANT, "COL-120.pdf");
    expect(buffer?.toString()).toBe("%PDF-root");
  });

  it("reports a folder the server cannot see instead of returning an empty list", async () => {
    folder = path.join(os.tmpdir(), "signex-does-not-exist-" + Date.now());

    const listing = await listCollectionFolder(TENANT);

    expect(listing.documents).toEqual([]);
    expect(listing.error).toMatch(/does not exist on the server/);
  });
});
