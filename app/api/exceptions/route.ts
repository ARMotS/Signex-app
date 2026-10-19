import { NextRequest, NextResponse } from "next/server";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";
import { exceptionsCsv, loadExceptions } from "@/lib/exceptions";

/**
 * GET /api/exceptions?from=YYYY-MM-DD&to=YYYY-MM-DD[&format=csv]
 *
 * Everything in the invoice → collection → credit chain that needs the office
 * (lib/exceptions.ts). ADMIN only, this scope only — like the dashboard it is
 * an aggregate over the whole scope, so a scoping bug here would be a standing
 * side channel (covered in tests/isolation.test.ts).
 */
export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { searchParams } = new URL(request.url);
  const day = (v: string | null, end: boolean) => {
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    const d = new Date(`${v}T${end ? "23:59:59.999" : "00:00:00"}Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };

  const result = await loadExceptions(ctx.tenantId, {
    from: day(searchParams.get("from"), false),
    to: day(searchParams.get("to"), true),
    // The page shows the first rows of each list; the CSV carries them all.
    rowsPerList: searchParams.get("format") === "csv" ? Number.POSITIVE_INFINITY : undefined,
  });

  if (searchParams.get("format") === "csv") {
    return new Response(exceptionsCsv(result.lists), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="signex-exceptions-${new Date().toISOString().slice(0, 10)}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return NextResponse.json(result);
});
