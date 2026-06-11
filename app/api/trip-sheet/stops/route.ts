import { NextRequest, NextResponse } from "next/server";
import { getTripSheetsForDriver, updateStopStatus } from "@/lib/trip-data";
import type { StopStatus } from "@/lib/trip-data";
import { prisma } from "@/lib/db";
import { getSessionContext } from "@/lib/tenant";
import { withAuth } from "@/lib/api-handler";

export const GET = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();

  const { searchParams } = new URL(request.url);
  const driverId = searchParams.get("driverId");

  if (!driverId) {
    return NextResponse.json(
      { error: "driverId query parameter is required" },
      { status: 400 }
    );
  }

  // Verify the driver belongs to this tenant
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver || driver.tenantId !== ctx.tenantId) {
    return NextResponse.json({ error: "Driver not found" }, { status: 404 });
  }

  // Drivers can only view their own stops
  if (ctx.role === "DRIVER") {
    const ownDriver = await prisma.driver.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
    });
    if (!ownDriver || ownDriver.id !== driverId) {
      return NextResponse.json({ error: "Driver not found" }, { status: 404 });
    }
  }

  const tripSheets = await getTripSheetsForDriver(driverId);
  const activeSheets = tripSheets.filter((t) => t.status === "ACTIVE");
  const stops = activeSheets.flatMap((sheet) =>
    sheet.stops.map((s) => ({ ...s, tripSheetDate: sheet.uploadedAt }))
  );
  return NextResponse.json({ stops, tripSheets });
});

export const PUT = withAuth(async (request: NextRequest) => {
  const ctx = await getSessionContext();

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

  // Verify stop belongs to this tenant
  const stop = await prisma.stop.findUnique({
    where: { id: stopId },
    include: { tripSheet: { select: { driverId: true } } },
  });
  if (!stop || stop.tenantId !== ctx.tenantId) {
    return NextResponse.json({ error: "Stop not found" }, { status: 404 });
  }

  // Drivers can only update their own stops
  if (ctx.role === "DRIVER") {
    const driver = await prisma.driver.findFirst({
      where: { id: ctx.userId, tenantId: ctx.tenantId },
    });
    if (!driver || stop.tripSheet.driverId !== driver.id) {
      return NextResponse.json({ error: "Stop not found" }, { status: 404 });
    }
  }

  const result = await updateStopStatus(stopId, status, signatureData);
  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Contact lookup / auto-create when signing
  let contactId: string | null = null;
  let contactHasEmail = false;

  if (status === "SIGNED") {
    let contact = await prisma.contact.findFirst({
      where: { tenantId: ctx.tenantId, deletedAt: null, companyName: { equals: stop.customerName, mode: 'insensitive' } },
    });
    if (!contact) {
      contact = await prisma.contact.create({
        data: { tenantId: ctx.tenantId, companyName: stop.customerName, address: stop.address, source: 'AUTO_CREATED' },
      });
    }
    await prisma.stop.update({ where: { id: stopId }, data: { contactId: contact.id } });
    contactId = contact.id;
    contactHasEmail = !!contact.email;
  }

  return NextResponse.json({ success: true, contactId, contactHasEmail });
});
