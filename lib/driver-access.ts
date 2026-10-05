/**
 * Per-driver narrowing for the routes a DRIVER can reach.
 *
 * The scoped client keeps a driver inside their own ADMIN's scope, but a scope
 * holds every driver of that company. Routes that address a file or a stop
 * directly therefore also need "is this on one of MY trip sheets?" — without
 * it, any signed-in driver could open a colleague's invoices by typing the
 * filename into the URL.
 *
 * Each check answers false for "not yours" and "does not exist" alike; callers
 * turn false into a 404 so the answer never confirms someone else's file.
 *
 * `driverId` is the session's own id (ctx.userId for a DRIVER), never a value
 * from the request.
 */

import type { ScopedPrismaClient } from "./db-scoped";

/** The invoice PDF is attached to a stop on one of this driver's trip sheets. */
export async function driverOwnsInvoiceFile(
  db: ScopedPrismaClient,
  driverId: string,
  filename: string
): Promise<boolean> {
  const stop = await db.stop.findFirst({
    where: { invoiceFile: filename, tripSheet: { driverId } },
    select: { id: true },
  });
  return stop !== null;
}

/** The stop is on one of this driver's trip sheets. */
export async function driverOwnsStop(
  db: ScopedPrismaClient,
  driverId: string,
  stopId: string
): Promise<boolean> {
  const stop = await db.stop.findFirst({
    where: { id: stopId, tripSheet: { driverId } },
    select: { id: true },
  });
  return stop !== null;
}

/**
 * The collection document (pending or signed) belongs to a collection on one
 * of this driver's trip sheets.
 */
export async function driverOwnsCollectionDocument(
  db: ScopedPrismaClient,
  driverId: string,
  filename: string,
  signed: boolean
): Promise<boolean> {
  const collection = await db.collection.findFirst({
    where: {
      ...(signed ? { signedFilePath: filename } : { sourceFilePath: filename }),
      tripSheet: { driverId },
    },
    select: { id: true },
  });
  return collection !== null;
}
