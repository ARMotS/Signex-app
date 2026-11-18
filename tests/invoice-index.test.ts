import { describe, expect, it } from "vitest";
import { invoiceFilesFromIndex, nameKeyOf, type IndexRow } from "@/lib/invoice-index";
import { planDeltaPage } from "@/lib/invoice-index-sync";

const FOLDER = "folder-1";
const SIGNED = "signed-1";

const row = (parentId: string, filename: string, modified = "2026-11-01T08:00:00Z", sizeBytes = 100): IndexRow => ({
  parentId,
  filename,
  nameKey: nameKeyOf(filename),
  sizeBytes,
  modifiedAt: new Date(modified),
});

describe("invoiceFilesFromIndex — the list the folder listing used to give", () => {
  it("lists originals only, signed when signed/ holds the same name in any case", () => {
    const files = invoiceFilesFromIndex(
      [
        row(FOLDER, "IV-200.pdf"),
        row(FOLDER, "iv-100.PDF"),
        row(SIGNED, "IV-100.pdf", "2026-11-02T09:30:00Z"),
        // A signed copy with no original is not listed, as before.
        row(SIGNED, "IV-999.pdf"),
        // Deeper folders and other files are kept in the index but never shown.
        row("archive-1", "IV-300.pdf"),
        row(FOLDER, "notes.txt"),
      ],
      FOLDER,
      SIGNED
    );
    expect(files.map((f) => f.filename)).toEqual(["iv-100.PDF", "IV-200.pdf"]);
    expect(files[0]).toMatchObject({
      name: "iv-100",
      invoiceNumber: "IV-100",
      isSigned: true,
      signedAt: "2026-11-02T09:30:00.000Z",
      sizeBytes: 100,
      lastModified: "2026-11-01T08:00:00.000Z",
    });
    expect(files[1]).toMatchObject({ isSigned: false, signedAt: undefined });
  });

  it("with no signed/ folder known, nothing is signed", () => {
    const files = invoiceFilesFromIndex([row(FOLDER, "IV-1.pdf"), row(SIGNED, "IV-1.pdf")], FOLDER, null);
    expect(files).toHaveLength(1);
    expect(files[0].isSigned).toBe(false);
  });
});

describe("planDeltaPage — what one page of Graph delta means", () => {
  const file = (id: string, name: string, parent: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    size: 1234,
    lastModifiedDateTime: "2026-11-18T07:00:00Z",
    parentReference: { id: parent },
    file: {},
    ...extra,
  });

  it("indexes PDFs with the folder they sit in, and finds signed/", () => {
    const plan = planDeltaPage(
      [
        { id: FOLDER, name: "Invoices", folder: {}, parentReference: { id: "root" } },
        { id: SIGNED, name: "Signed", folder: {}, parentReference: { id: FOLDER } },
        file("a", "IV-1.pdf", FOLDER),
        file("b", "IV-1.pdf", SIGNED),
        file("c", "readme.docx", FOLDER),
      ],
      FOLDER,
      null
    );
    expect(plan.signedFolderId).toBe(SIGNED);
    expect(plan.folderDeleted).toBe(false);
    expect(plan.upserts.map((u) => [u.itemId, u.parentId, u.nameKey])).toEqual([
      ["a", FOLDER, "iv-1.pdf"],
      ["b", SIGNED, "iv-1.pdf"],
    ]);
    expect(plan.upserts[0]).toMatchObject({ sizeBytes: 1234, modifiedAt: new Date("2026-11-18T07:00:00Z") });
    // Not a PDF: dropped in case it used to be one.
    expect(plan.removeItemIds).toEqual(["c"]);
  });

  it("a deleted item goes, and a deleted folder takes its rows with it", () => {
    const plan = planDeltaPage([{ id: "a", deleted: {} }, { id: SIGNED, deleted: {} }], FOLDER, SIGNED);
    expect(plan.removeItemIds.sort()).toEqual(["a", SIGNED].sort());
    expect(plan.removeParentIds).toContain(SIGNED);
    expect(plan.signedFolderId).toBeNull();
    expect(plan.upserts).toEqual([]);
  });

  it("the last mention of an item wins within a page", () => {
    const created = planDeltaPage([file("a", "IV-1.pdf", FOLDER), { id: "a", deleted: {} }], FOLDER, null);
    expect(created.upserts).toEqual([]);
    expect(created.removeItemIds).toEqual(["a"]);

    const renamed = planDeltaPage([file("a", "IV-1.pdf", FOLDER), file("a", "IV-1 (2).pdf", FOLDER)], FOLDER, null);
    expect(renamed.upserts.map((u) => u.filename)).toEqual(["IV-1 (2).pdf"]);
  });

  it("signed/ renamed or moved away is no longer the signed folder", () => {
    expect(planDeltaPage([{ id: SIGNED, name: "old", folder: {}, parentReference: { id: FOLDER } }], FOLDER, SIGNED).signedFolderId).toBeNull();
    expect(planDeltaPage([{ id: SIGNED, name: "signed", folder: {}, parentReference: { id: "elsewhere" } }], FOLDER, SIGNED).signedFolderId).toBeNull();
    // A folder called signed deeper down is not it.
    expect(planDeltaPage([{ id: "x", name: "signed", folder: {}, parentReference: { id: "archive" } }], FOLDER, null).signedFolderId).toBeNull();
  });

  it("notices the invoice folder itself being deleted", () => {
    expect(planDeltaPage([{ id: FOLDER, deleted: {} }], FOLDER, SIGNED).folderDeleted).toBe(true);
  });

  it("ignores items it cannot place", () => {
    const plan = planDeltaPage([{ id: "", name: "x.pdf" } as never, { id: "p", name: "IV-2.pdf", file: {} }], FOLDER, null);
    // No parent: cannot say which folder it is in, so it is not indexed — and
    // is counted, so the look fails rather than build an index without it.
    expect(plan.upserts).toEqual([]);
    expect(plan.removeItemIds).toEqual(["p"]);
    expect(plan.unplaced).toBe(1);
    expect(planDeltaPage([{ id: "q", name: "notes.txt", file: {} }], FOLDER, null).unplaced).toBe(0);
  });
});
