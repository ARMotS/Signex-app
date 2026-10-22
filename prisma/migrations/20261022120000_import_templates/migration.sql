-- Import templates: an ADMIN's description of their own spreadsheet layout,
-- and the record on each trip sheet of which template read it.
--
-- Additive only: a new enum, a new table, and two nullable columns on
-- TripSheet. The layout trip sheets have always used is not a row here — it
-- is defined in code (BUILT_IN_TRIP_SHEET) — so nothing is backfilled and
-- every existing upload reads exactly as before.
--
-- "One default per scope and sheet type" is kept by lib/sheet-templates.ts in
-- a transaction, not by a partial unique index: the Prisma schema cannot
-- express one, so it would read as drift and a later generated migration
-- would drop it.

-- CreateEnum
CREATE TYPE "ImportSheetType" AS ENUM ('TRIP_SHEET', 'COURIER_TRIP_SHEET');

-- AlterTable
ALTER TABLE "TripSheet" ADD COLUMN     "importTemplateId" TEXT,
ADD COLUMN     "mappingSnapshot" JSONB;

-- CreateTable
CREATE TABLE "ImportTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "sheetType" "ImportSheetType" NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "worksheet" TEXT,
    "headerRow" INTEGER NOT NULL,
    "dataStartRow" INTEGER NOT NULL,
    "stopAtBlankRows" INTEGER NOT NULL DEFAULT 2,
    "headerFingerprint" TEXT NOT NULL,
    "mappings" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportTemplate_tenantId_sheetType_idx" ON "ImportTemplate"("tenantId", "sheetType");

-- CreateIndex
CREATE UNIQUE INDEX "ImportTemplate_tenantId_sheetType_name_key" ON "ImportTemplate"("tenantId", "sheetType", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ImportTemplate_tenantId_id_key" ON "ImportTemplate"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "ImportTemplate" ADD CONSTRAINT "ImportTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

