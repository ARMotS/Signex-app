import { NextRequest, NextResponse } from "next/server";
import { getTripSheetsForDriver, updateStopStatus } from "@/lib/trip-data";
import type { StopStatus } from "@/lib/trip-data";
import { getScope } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();

  const { searchParams } = new URL(request.url);
  const driverId = searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "driverId query parameter is required" },
      { status: 400 }
    );
  }

  // driverId is client-supplied. The scoped read resolves it against this scope
  // only, so a driver belonging to another ADMIN is "not found" — 404, never a
  // 403 that would confirm the id exists somewhere.
  const driver = await ctx.db.driver.findFirst({ where: { id: driverId } });
  if (!driver) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  // Drivers can only view their own stops
  if (ctx.role === "DRIVER") {
    const ownDriver = await ctx.db.driver.findFirst({ where: { id: ctx.userId } });
    if (!ownDriver || ownDriver.id !== driverId) {
      return NextResponse.json({ error: "Driver not found" }, { status: 404 });
    }
  }

  const tripSheets = await getTripSheetsForDriver(ctx.tenantId, driverId);
  const activeSheets = tripSheets.filter((t) => t.status === "ACTIVE");
  const stops = activeSheets.flatMap((sheet) =>
    sheet.stops.map((s) => ({ ...s, tripSheetDate: sheet.uploadedAt }))
  );
  return NextResponse.json({ stops, tripSheets });
});

export const PUT = withAuth(async (request: NextRequest) => {
  const ctx = await getScope();

  const { stopId, status, signatureData } = await request.json();

  if (!stopId || !status) {
    return NextResponse.json(
      { error: "stopId and status are required" },
      { status: 400 }
    );
  }

  const validStatuses: StopStatus[] = ["PENDING", "IN_PROGRESS", "SIGNED"];
  if (!validStatuses.includes(status)) {
    return NextResponse.json(
      { error: `Invalid status. Use: ${validStatuses.join(", ")}` },
      { status: 400 }
    );
  }

  // Scoped read — a stop in another ADMIN's scope is not found.
  const stop = await ctx.db.stop.findFirst({
    where: { id: stopId },
    include: { tripSheet: { select: { driverId: true } } },
  });
  if (!stop) {
    return NextResponse.json({ error: "Stop not found" }, { status: 404 });
  }

  // Drivers can only update their own stops
  if (ctx.role === "DRIVER") {
    const driver = await ctx.db.driver.findFirst({ where: { id: ctx.userId } });
    if (!driver || stop.tripSheet.driverId !== driver.id) {
      return NextResponse.json({ error: "Stop not found" }, { status: 404 });
    }
  }

  const result = await updateStopStatus(ctx.tenantId, stopId, status, signatureData);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Contact lookup / auto-create when signing — this scope's contacts only.
  let contactId: string | null = null;
  let contactHasEmail = false;

  if (status === "SIGNED") {
    let contact = await ctx.db.contact.findFirst({
      where: { deletedAt: null, companyName: { equals: stop.customerName, mode: 'insensitive' } },
    });
    if (!contact) {
      contact = await ctx.db.contact.create({
        data: { companyName: stop.customerName, address: stop.address, source: 'AUTO_CREATED' },
      });
    }
    await ctx.db.stop.update({ where: { id: stopId }, data: { contactId: contact.id } });
    contactId = contact.id;
    contactHasEmail = !!contact.email;
  }

  return NextResponse.json({ success: true, contactId, contactHasEmail });
});
