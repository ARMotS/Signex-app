import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { logAudit } from "@/lib/audit";
import { deleteCollectionDocument } from "@/lib/collections";

/**
 * DELETE /api/collections/sheets/[name] — remove an unsigned sheet from the
 * collections folder (Pending/, or the folder root). Addressed by filename, as
 * /api/collections/document/[name] is, and against the caller's own folder.
 * Never Signed/: that is the permanent record behind a credit note.
 *
 * A sheet a collection still depends on is 409. ADMIN only.
 */
export const DELETE = withAuth(async (
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { name } = await params;
  const filename = decodeURIComponent(name);

  const result = await deleteCollectionDocument(ctx.tenantId, filename);
  switch (result.outcome) {
    case "not_found":
      return NextResponse.json({ error: "That sheet is not in the collections folder" }, { status: 404 });
    case "in_use":
      return NextResponse.json(
        { error: `Collection ${result.collectionNos.join(", ")} still needs this sheet, so it cannot be deleted.`, collectionNos: result.collectionNos },
        { status: 409 }
      );
    default:
      await logAudit({
        action: "FILE_DELETE",
        entity: "collection_document",
        userName: ctx.name ?? undefined,
        details: `Collection sheet ${filename} deleted from the collections folder`,
        metadata: { filenames: [filename] },
        tenantId: ctx.tenantId,
      });
      return NextResponse.json({ success: true });
  }
});
