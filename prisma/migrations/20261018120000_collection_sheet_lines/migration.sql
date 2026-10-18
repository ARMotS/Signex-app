-- The office's collection sheet, read into lines.
--
-- Additive only: a new enum, nullable columns plus one with a default, and a
-- new table. Nothing the previous deploy runs reads any of it. Existing
-- collections start MISSING and are read on the next re-check while their
-- trip has not started.

-- CreateEnum
CREATE TYPE "CollectionSheetStatus" AS ENUM ('MISSING', 'READY', 'NEEDS_REVIEW');

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "sheetCheckedAt" TIMESTAMP(3),
ADD COLUMN     "sheetError" TEXT,
ADD COLUMN     "sheetFileModified" TIMESTAMP(3),
ADD COLUMN     "sheetHeader" JSONB,
ADD COLUMN     "sheetIssues" JSONB,
ADD COLUMN     "sheetReadAt" TIMESTAMP(3),
ADD COLUMN     "sheetReviewedAt" TIMESTAMP(3),
ADD COLUMN     "sheetReviewedBy" TEXT,
ADD COLUMN     "sheetSource" TEXT,
ADD COLUMN     "sheetStatus" "CollectionSheetStatus" NOT NULL DEFAULT 'MISSING';

-- CreateTable
CREATE TABLE "CollectionLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "collectionId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemCode" TEXT,
    "shortName" TEXT,
    "description" TEXT NOT NULL,
    "qtyListed" INTEGER NOT NULL,
    "qtyReturnedPrinted" INTEGER,
    "reasonCode" TEXT,
    "type" "CollectionType" NOT NULL DEFAULT 'CREDIT_RETURN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CollectionLine_tenantId_collectionId_idx" ON "CollectionLine"("tenantId", "collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionLine_tenantId_collectionId_lineNo_key" ON "CollectionLine"("tenantId", "collectionId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_tenantId_id_key" ON "Collection"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "CollectionLine" ADD CONSTRAINT "CollectionLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionLine" ADD CONSTRAINT "CollectionLine_tenantId_collectionId_fkey" FOREIGN KEY ("tenantId", "collectionId") REFERENCES "Collection"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- A quantity printed on a sheet is never negative; a parse that produced one
-- is a bug to surface, not a row to store.
ALTER TABLE "CollectionLine" ADD CONSTRAINT "CollectionLine_qty_nonnegative" CHECK ("qtyListed" >= 0 AND ("qtyReturnedPrinted" IS NULL OR "qtyReturnedPrinted" >= 0));
