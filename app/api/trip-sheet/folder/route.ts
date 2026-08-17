import { NextRequest, NextResponse } from "next/server";
import { parseTripSheet } from "@/lib/trip-parser";
import {
  listTripSheetFiles,
  readTripSheetFile,
  markFileImported,
  deleteTripSheetFiles,
  findDuplicateTripSheetFiles,
} from "@/lib/trip-sheet-folder";
import {
  saveTripSheet,
} from "@/lib/trip-data";
import { describeCloudProvider } from "@/lib/cloud-detect";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

/** Cloud imports list a remote folder and parse a spreadsheet — see the note
 *  on maxDuration in ../route.ts. */
export const maxDuration = 60;

export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const [folderInfo, duplicates] = await Promise.all([
    listTripSheetFiles(ctx.tenantId),
    findDuplicateTripSheetFiles(ctx.tenantId),
  ]);

  // The label comes from whatever actually listed the files. It used to be
  // re-derived from getTripSheetFolderPath(), which reads only the LOCAL
  // config — so an ADMIN whose trip sheets live in OneDrive had an empty local
  // path and got a heading reading "Not configured Folder" above a folder that
  // was connected and listing files perfectly well.
  const cloudInfo = describeCloudProvider(folderInfo.provider, folderInfo.accessible);

  return NextResponse.json({
    ...folderInfo,
    cloud: cloudInfo,
    duplicates,
  });
});

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const { filename, action, assignTo, skipInvoices: skipInvoicesRaw } = body;

  if (!filename || typeof filename !== "string") {
    return NextResponse.json(
      { error: "Missing filename" },
      { status: 400 }
    );
  }

  const skipInvoices: Set<string> = new Set(
    Array.isArray(skipInvoicesRaw)
      ? skipInvoicesRaw.map((s: string) => String(s).toUpperCase())
      : []
  );

  const file = await readTripSheetFile(ctx.tenantId, filename);
  if (!file) {
    return NextResponse.json(
      { error: `File not found: ${filename}` },
      { status: 404 }
    );
  }

  const parseResult = await parseTripSheet(ctx.tenantId, file.buffer, file.filename);

  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error },
      { status: 400 }
    );
  }

  if (action === "deploy") {
    // assignTo.driverId is client-supplied — confirm it is in this scope before
    // any trip sheet is written against it.
    let resolvedAssignTo: { driverId: string; driverName: string } | null = null;
    if (assignTo?.driverId) {
      const target = await ctx.db.driver.findFirst({
        where: { id: assignTo.driverId },
        select: { id: true, name: true },
      });
      if (!target) {
        return NextResponse.json({ error: "Driver not found" }, { status: 404 });
      }
      resolvedAssignTo = { driverId: target.id, driverName: target.name };
    }

    const savedTrips = [];

    for (const result of parseResult.driverResults) {
      const stops = skipInvoices.size > 0
        ? result.stops.filter((s) => !skipInvoices.has(s.invoiceNumber.toUpperCase()))
        : result.stops;

      if (stops.length === 0) continue;

      const renumberedStops = stops.map((s, idx) => ({ ...s, stopNumber: idx + 1 }));

      if (result.driverId === "__unassigned__") {
        if (resolvedAssignTo) {
          const trip = await saveTripSheet(ctx.tenantId, {
            driverId: resolvedAssignTo.driverId,
            driverName: resolvedAssignTo.driverName,
            regNo: result.regNo,
            uploadedBy: ctx.userId,
            sourceFilename: filename,
            stops: renumberedStops,
          });
          savedTrips.push(trip);
        }
        continue;
      }

      const trip = await saveTripSheet(ctx.tenantId, {
        driverId: result.driverId,
        driverName: result.driverName,
        regNo: result.regNo,
        uploadedBy: ctx.userId,
        sourceFilename: filename,
        stops: renumberedStops,
      });
      savedTrips.push(trip);
    }

    const tripSheetId = savedTrips.length > 0 ? savedTrips[0].id : null;
    // Note: the source file is NOT archived to processed/ here. That happens
    // when the trip sheet is completed (see completeTripSheet), because the
    // processed/ folder is what the backup flow treats as "completed".
    await markFileImported(ctx.tenantId, filename, tripSheetId, "imported");

    return NextResponse.json({
      success: true,
      deployed: true,
      tripSheets: savedTrips.length,
      totalStops: savedTrips.reduce((sum, t) => sum + t.stops.length, 0),
    });
  }

  return NextResponse.json({
    success: true,
    deployed: false,
    filename,
    preview: parseResult,
  });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { filenames } = await request.json();
  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json(
      { error: "filenames array is required" },
      { status: 400 }
    );
  }

  const result = await deleteTripSheetFiles(ctx.tenantId, filenames);

  return NextResponse.json({
    success: true,
    deleted: result.deleted,
    failed: result.failed,
  });
});
