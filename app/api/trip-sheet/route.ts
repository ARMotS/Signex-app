import { NextRequest, NextResponse } from "next/server";
import { parseTripSheet } from "@/lib/trip-parser";
import {
  saveTripSheet,
  getAllTripSheets,
  deleteTripSheet,
  deleteTripSheets,
  completeTripSheet,
  completeTripSheets,
  getTripStats,
} from "@/lib/trip-data";
import { matchStopsToContacts, applyContactMatches } from "@/lib/contact-matcher";
import { saveUploadedFile } from "@/lib/trip-sheet-folder";
import { getScope, requireRole } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const POST = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json(
      { error: "No file uploaded" },
      { status: 400 }
    );
  }

  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json(
      { error: "File too large. Maximum size is 10MB." },
      { status: 400 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parseResult = await parseTripSheet(ctx.tenantId, buffer, file.name);

  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error },
      { status: 400 }
    );
  }

  const action = formData.get("action") as string | null;

  if (action === "deploy") {
    await saveUploadedFile(ctx.tenantId, file.name, buffer);

    const assignToRaw = formData.get("assignTo") as string | null;
    let assignTo: { driverId: string; driverName: string } | null = null;
    if (assignToRaw) {
      try {
        assignTo = JSON.parse(assignToRaw);
      } catch {
        // ignore
      }
    }

    // A driverId arriving in the request body is client-supplied, so it is
    // verified against this scope before anything is written to it.
    if (assignTo?.driverId) {
      const target = await ctx.db.driver.findFirst({
        where: { id: assignTo.driverId },
        select: { id: true, name: true },
      });
      if (!target) {
        return NextResponse.json({ error: "Driver not found" }, { status: 404 });
      }
      assignTo = { driverId: target.id, driverName: target.name };
    }

    const skipInvoicesRaw = formData.get("skipInvoices") as string | null;
    let skipInvoices: Set<string> = new Set();
    if (skipInvoicesRaw) {
      try {
        const arr = JSON.parse(skipInvoicesRaw);
        if (Array.isArray(arr)) {
          skipInvoices = new Set(arr.map((s: string) => s.toUpperCase()));
        }
      } catch {
        // ignore
      }
    }

    const savedTrips = [];
    for (const result of parseResult.driverResults) {
      const stops = skipInvoices.size > 0
        ? result.stops.filter((s) => !skipInvoices.has(s.invoiceNumber.toUpperCase()))
        : result.stops;

      if (stops.length === 0) continue;

      const renumberedStops = stops.map((s, idx) => ({ ...s, stopNumber: idx + 1 }));

      if (result.driverId === "__unassigned__") {
        if (assignTo) {
          const trip = await saveTripSheet(ctx.tenantId, {
            driverId: assignTo.driverId,
            driverName: assignTo.driverName,
            regNo: result.regNo,
            uploadedBy: ctx.userId,
            sourceFilename: file.name,
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
        sourceFilename: file.name,
        stops: renumberedStops,
      });
      savedTrips.push(trip);
    }

    const savedStops = savedTrips.flatMap((t) =>
      t.stops.map((s) => ({ id: s.id, customerName: s.customerName }))
    );
    let matchResults = undefined;
    if (savedStops.length > 0) {
      matchResults = await matchStopsToContacts(ctx.tenantId, savedStops);
      const autoMatches = matchResults
        .filter((m) => m.status === "auto" && m.contactId)
        .map((m) => ({ stopId: m.stopId, contactId: m.contactId! }));
      if (autoMatches.length) await applyContactMatches(ctx.tenantId, autoMatches);
    }

    return NextResponse.json({
      success: true,
      deployed: true,
      tripSheets: savedTrips.length,
      totalStops: savedTrips.reduce((sum, t) => sum + t.stops.length, 0),
      matchResults,
    });
  }

  return NextResponse.json({
    success: true,
    deployed: false,
    preview: parseResult,
  });
});

export const GET = withAuth(async () => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const tripSheets = await getAllTripSheets(ctx.tenantId);
  const stats = await getTripStats(ctx.tenantId);

  return NextResponse.json({
    tripSheets,
    stats,
  });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const { id, ids } = body;

  if (ids && Array.isArray(ids) && ids.length > 0) {
    // Narrow client-supplied ids to this scope. Foreign ids simply drop out.
    const trips = await ctx.db.tripSheet.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const validIds = trips.map((t) => t.id);
    const result = await deleteTripSheets(ctx.tenantId, validIds);
    return NextResponse.json({
      success: true,
      deleted: result.deleted,
      failed: result.failed,
    });
  }

  if (!id) {
    return NextResponse.json(
      { error: "Trip sheet ID is required" },
      { status: 400 }
    );
  }

  const trip = await ctx.db.tripSheet.findFirst({ where: { id } });
  if (!trip) {
    // 404, not 403 — an id in another scope is indistinguishable from one that
    // doesn't exist.
    return NextResponse.json({ error: "Trip sheet not found" }, { status: 404 });
  }

  const result = await deleteTripSheet(ctx.tenantId, id);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true });
});

export const PATCH = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();
  requireRole(ctx, "ADMIN", "SUPER_ADMIN");

  const body = await request.json();
  const { id, ids } = body;

  if (ids && Array.isArray(ids) && ids.length > 0) {
    const trips = await ctx.db.tripSheet.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const validIds = trips.map((t) => t.id);
    const result = await completeTripSheets(ctx.tenantId, validIds);
    return NextResponse.json({
      success: true,
      completed: result.completed,
      failed: result.failed,
    });
  }

  if (!id) {
    return NextResponse.json(
      { error: "Trip sheet ID is required" },
      { status: 400 }
    );
  }

  const trip = await ctx.db.tripSheet.findFirst({ where: { id } });
  if (!trip) {
    return NextResponse.json({ error: "Trip sheet not found" }, { status: 404 });
  }

  const result = await completeTripSheet(ctx.tenantId, id);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    archivedFile: result.archivedFile,
  });
});
