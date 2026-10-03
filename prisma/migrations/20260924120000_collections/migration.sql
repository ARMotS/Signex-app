-- Collections: credit returns and non-credit uplifts.
--
-- A collection is the mirror image of a delivery. The driver takes something
-- AWAY from the customer and captures a signature for it, the same way they do
-- for an invoice. Collections arrive on the same trip sheet — a new COLLECTNO
-- column between INVOICENO and NOP — and hang off the same customer Stop, so a
-- driver sees one visit with two lists rather than two jobs at one address.
--
-- Isolation is Stop's, unchanged. Collection carries a NOT NULL tenantId with a
-- foreign key to Tenant, and composite foreign keys to [tenantId, id] on
-- TripSheet, Stop and Driver make a row that points into another scope
-- unrepresentable. Stop did not previously have a [tenantId, id] unique
-- constraint — it was never a composite-FK target — so one is added below.
--
-- The DEFAULT '' on tenantId is the same type-level convenience used
-- everywhere else: the scoped client injects the real value, and the foreign
-- key rejects an actual ''.

CREATE TYPE "CollectionType" AS ENUM ('CREDIT_RETURN', 'NON_CREDIT_UPLIFT');

CREATE TYPE "UpliftSubtype" AS ENUM ('COMPANY_PARCEL', 'EQUIPMENT_OR_CRATES', 'DOCUMENTS', 'SPECIAL_REQUEST');

-- Four terminal states rather than a boolean, because accounts treats them
-- differently: COLLECTED and PARTIAL raise a credit (for different amounts),
-- NOT_AVAILABLE means try again another day, and REFUSED means the customer
-- declined and no credit may be raised at all.
CREATE TYPE "CollectionStatus" AS ENUM ('PENDING', 'COLLECTED', 'PARTIAL', 'NOT_AVAILABLE', 'REFUSED');

-- Composite-FK target so a Collection cannot hang off another scope's stop.
CREATE UNIQUE INDEX "Stop_tenantId_id_key" ON "Stop"("tenantId", "id");

CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "collectionNo" TEXT NOT NULL,
    "type" "CollectionType" NOT NULL,
    "upliftSubtype" "UpliftSubtype",
    "notes" TEXT,
    "originalInvoiceNo" TEXT,
    "status" "CollectionStatus" NOT NULL DEFAULT 'PENDING',
    "exceptionReason" TEXT,
    "expectedQty" INTEGER,
    "collectedQty" INTEGER,
    "sourceFileId" TEXT,
    "sourceFilePath" TEXT,
    "signedFileId" TEXT,
    "signedFilePath" TEXT,
    "signature" TEXT,
    "signedByName" TEXT,
    "collectedAt" TIMESTAMP(3),
    "driverId" TEXT,
    "tripSheetId" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- A collection number identifies one job on one trip. The same number may
-- legitimately recur on a later trip, so the constraint is per trip, not global
-- and not per scope.
CREATE UNIQUE INDEX "Collection_tenantId_tripSheetId_collectionNo_key"
  ON "Collection"("tenantId", "tripSheetId", "collectionNo");

CREATE INDEX "Collection_tenantId_idx" ON "Collection"("tenantId");
CREATE INDEX "Collection_tripSheetId_idx" ON "Collection"("tripSheetId");
CREATE INDEX "Collection_stopId_idx" ON "Collection"("stopId");
CREATE INDEX "Collection_tenantId_status_idx" ON "Collection"("tenantId", "status");
-- Drives the credit-return report: type + date range without scanning a
-- scope's whole collection history.
CREATE INDEX "Collection_tenantId_type_collectedAt_idx"
  ON "Collection"("tenantId", "type", "collectedAt");

ALTER TABLE "Collection"
  ADD CONSTRAINT "Collection_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Collection"
  ADD CONSTRAINT "Collection_tenantId_tripSheetId_fkey"
  FOREIGN KEY ("tenantId", "tripSheetId") REFERENCES "TripSheet"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "Collection"
  ADD CONSTRAINT "Collection_tenantId_stopId_fkey"
  FOREIGN KEY ("tenantId", "stopId") REFERENCES "Stop"("tenantId", "id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- Restrict, not SetNull: the composite key includes the NOT NULL tenantId, so
-- SetNull would try to null it. Same reasoning as Stop.contact.
ALTER TABLE "Collection"
  ADD CONSTRAINT "Collection_tenantId_driverId_fkey"
  FOREIGN KEY ("tenantId", "driverId") REFERENCES "Driver"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;

-- Completing a trip deletes it and cascades the collections away, so the
-- snapshot has to carry them. This is the whole record once a trip is closed:
-- the archive view and the credit-return report read signedFilePath from here.
-- Nullable with no backfill — a trip archived before collections existed has
-- none, and readers treat null as an empty list.
ALTER TABLE "CompletedTripSheet" ADD COLUMN "totalCollections" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CompletedTripSheet" ADD COLUMN "collectedCollections" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CompletedTripSheet" ADD COLUMN "collections" JSONB;

-- The collections folder is a SIBLING of the invoice folder, never inside it:
-- the invoice listing and the collections listing must not see each other's
-- documents. lib/collections.ts rejects a nested configuration.
ALTER TABLE "CloudAccount" ADD COLUMN "collectionsFolderPath" TEXT;
ALTER TABLE "CloudAccount" ADD COLUMN "collectionsFolderItemId" TEXT;
