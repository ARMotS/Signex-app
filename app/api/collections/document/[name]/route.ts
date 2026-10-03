import { NextRequest, NextResponse } from "next/server";
import {
  readCollectionDocument,
  readSignedCollectionDocument,
} from "@/lib/collections";
import { getScope } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/**
 * Serve a collection document — the pending original, or the stamped output.
 *
 * Addressed by filename rather than by collection id, deliberately and exactly
 * as /api/invoices/[id] is. A collection on a completed trip has no row left to
 * address: it survives only as a frozen entry in the trip's archive, and
 * sourceFilePath / signedFilePath in that snapshot are the filenames this route
 * takes. One route therefore serves both live and archived collections, which is
 * what makes the archive view work at all.
 *
 * Every read resolves against the caller's own collections folder / OneDrive
 * connection, so the same filename in two scopes returns two different files —
 * and a filename that exists only in another ADMIN's folder returns 404. The
 * name itself is caller-supplied and goes through the same traversal guards as
 * an invoice filename (assertSafeItemName on the Graph side,
 * resolveWithinFolder on the local one).
 *
 *   ?signed=true  → the stamped receipt in Signed/
 *   otherwise     → the original in Pending/, or directly in the folder
 */
export const GET = withAuth(async (
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) => {
  const ctx = await getScope();
  const { name } = await params;
  const filename = decodeURIComponent(name);

  const wantSigned = new URL(request.url).searchParams.get("signed") === "true";

  let buffer: Buffer | null = null;
  try {
    buffer = wantSigned
      ? await readSignedCollectionDocument(ctx.tenantId, filename)
      : await readCollectionDocument(ctx.tenantId, filename);
  } catch {
    // A traversal attempt and a missing file are the same answer on purpose.
    return NextResponse.json({ error: "Collection document not found" }, { status: 404 });
  }

  if (!buffer) {
    return NextResponse.json(
      {
        error: wantSigned
          ? `Signed collection document "${filename}" not found`
          : `Collection document "${filename}" not found`,
      },
      { status: 404 }
    );
  }

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${wantSigned ? "signed-" : ""}${filename}"`,
      "Cache-Control": "no-cache",
    },
  });
});
