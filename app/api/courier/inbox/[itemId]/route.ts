import { NextRequest, NextResponse } from "next/server";
import { getScope, requireOffice } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { downloadFileById } from "@/lib/microsoft-graph";

type Ctx = { params: Promise<{ itemId: string }> };

/**
 * A file the courier folder could not import, so the office can open the
 * template wizard on it. Only files this scope has listed as failed: the
 * item id comes from the browser, and the scoped failure row is what proves
 * it is a file in this scope's own folder — anything else is not found.
 */
export const GET = withAuth(async (_request: NextRequest, { params }: Ctx) => {
  const ctx = await getScope();
  requireOffice(ctx);
  const { itemId } = await params;

  const failure = await ctx.db.courierImportFailure.findFirst({
    where: { itemId },
    select: { itemId: true, fileName: true },
  });
  if (!failure) return NextResponse.json({ error: "File not found" }, { status: 404 });

  let buffer: Buffer;
  try {
    buffer = await downloadFileById(ctx.tenantId, failure.itemId);
  } catch {
    return NextResponse.json({ error: "The file is no longer in the folder" }, { status: 404 });
  }
  const xls = /\.xls$/i.test(failure.fileName);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": xls ? "application/vnd.ms-excel" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${failure.fileName.replace(/["\\\r\n]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
});
