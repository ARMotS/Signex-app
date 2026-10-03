import { NextRequest, NextResponse } from "next/server";
import { readCollectionDocument, resolveCollectionSource } from "@/lib/collections";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * GET /api/collections/[id]/source — the original collection sheet, for the
 * office's "Original" link on a live collection.
 *
 * Addressed by collection id rather than filename because the filename is
 * exactly what may be missing: a collection imported before its document was
 * in the folder has no sourceFilePath, and a filename-addressed link could
 * never be drawn for it. resolveCollectionSource matches it now and records the
 * match. Archived collections have no row and keep using
 * /api/collections/document/[name].
 *
 * A collection in another scope is not found — 404, never 403.
 */
export const GET = withAuth(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const collection = await ctx.db.collection.findFirst({
    where: { id },
    select: { id: true, collectionNo: true, sourceFilePath: true },
  });
  if (!collection) {
    return new NextResponse("Collection not found.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const filename = await resolveCollectionSource(ctx.tenantId, collection);
  const buffer = filename ? await readCollectionDocument(ctx.tenantId, filename) : null;

  if (!filename || !buffer) {
    // Opened in a new tab, so a sentence beats a JSON body.
    return new NextResponse(
      `No original collection sheet found for ${collection.collectionNo}.\n\n` +
        `Put a PDF named after the collection number (for example ${collection.collectionNo}.pdf) ` +
        `in your collections folder or its Pending subfolder, then try again.`,
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-cache",
    },
  });
});
