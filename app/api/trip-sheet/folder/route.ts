import { NextRequest, NextResponse } from "next/server";
import { parseTripSheet } from "@/lib/trip-parser";
import {
  listTripSheetFiles,
  readTripSheetFile,
  markFileImported,
  moveToProcessed,
  deleteTripSheetFiles,
  findDuplicateTripSheetFiles,
} from "@/lib/trip-sheet-folder";
import {
  saveTripSheet,
} from "@/lib/trip-data";
import { getCloudFolderInfo } from "@/lib/cloud-detect";
import { getTripSheetFolderPath } from "@/lib/trip-sheet-folder";
import { getSessionContext, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async () => {
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const folderInfo = await listTripSheetFiles();
  const folderPath = await getTripSheetFolderPath();
  const [cloudInfo, duplicates] = await Promise.all([
    Promise.resolve(
      folderPath
        ? getCloudFolderInfo(folderPath)
        : { provider: "local" as const, label: "Not configured", icon: "📁", synced: false }
    ),
    findDuplicateTripSheetFiles(),
  ]);

  return NextResponse.json({
    ...folderInfo,
    cloud: cloudInfo,
    duplicates,
  });
});

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();
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

  const file = await readTripSheetFile(filename);
  if (!file) {
    return NextResponse.json(
      { error: `File not found: ${filename}` },
      { status: 404 }
    );
  }

  const parseResult = await parseTripSheet(file.buffer, file.filename);

  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error },
      { status: 400 }
    );
  }

  if (action === "deploy") {
    const savedTrips = [];

    for (const result of parseResult.driverResults) {
      const stops = skipInvoices.size > 0
        ? result.stops.filter((s) => !skipInvoices.has(s.invoiceNumber.toUpperCase()))
        : result.stops;

      if (stops.length === 0) continue;

      const renumberedStops = stops.map((s, idx) => ({ ...s, stopNumber: idx + 1 }));

      if (result.driverId === "__unassigned__") {
        if (assignTo) {
          const trip = await saveTripSheet({
            driverId: assignTo.driverId,
            driverName: assignTo.driverName,
            regNo: result.regNo,
            uploadedBy: ctx.userId,
            sourceFilename: filename,
            stops: renumberedStops,
            tenantId: ctx.tenantId,
          });
          savedTrips.push(trip);
        }
        continue;
      }

      const trip = await saveTripSheet({
        driverId: result.driverId,
        driverName: result.driverName,
        regNo: result.regNo,
        uploadedBy: ctx.userId,
        sourceFilename: filename,
        stops: renumberedStops,
        tenantId: ctx.tenantId,
      });
      savedTrips.push(trip);
    }

    const tripSheetId = savedTrips.length > 0 ? savedTrips[0].id : null;
    await markFileImported(filename, tripSheetId, "imported");
    await moveToProcessed(filename);

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
  const ctx = await getSessionContext();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const { filenames } = await request.json();
  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json(
      { error: "filenames array is required" },
      { status: 400 }
    );
  }

  const result = await deleteTripSheetFiles(filenames);

  return NextResponse.json({
    success: true,
    deleted: result.deleted,
    failed: result.failed,
  });
});
