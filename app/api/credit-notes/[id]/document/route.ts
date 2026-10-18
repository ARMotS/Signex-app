import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { downloadFileById } from "@/lib/microsoft-graph";

/**
 * GET /api/credit-notes/[id]/document — the credit note's PDF, as filed.
 *
 * Addressed by the note's id, never by a filename or item id from the
 * request: the item id comes off this scope's own row, and is fetched with
 * this scope's own OneDrive token. Another scope's id is 404.
 */
export const GET = withAuth(async (
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");
  const { id } = await params;

  const note = await ctx.db.creditNote.findFirst({
    where: { id },
    select: { sourceItemId: true, sourceFilename: true },
  });
  if (!note) return NextResponse.json({ error: "Credit note not found" }, { status: 404 });

  let buffer: Buffer;
  try {
    buffer = await downloadFileById(ctx.tenantId, note.sourceItemId);
  } catch {
    return NextResponse.json(
      { error: "The file could not be fetched from OneDrive — it may have been moved or deleted." },
      { status: 502 }
    );
  }

  const safeName = note.sourceFilename.replace(/[^\w.\- ]/g, "_");
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "no-cache",
    },
  });
});
