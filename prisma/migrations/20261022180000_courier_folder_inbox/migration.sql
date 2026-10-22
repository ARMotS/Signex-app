-- Courier trip sheets arrive by folder: the folder the Trip application saves
-- them to, the throttle for looking at it, and the files that could not be
-- imported (the Courier tab's "Couldn't import" list).
--
-- Additive only: four nullable columns on CloudAccount and a new table.

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "courierCheckedAt" TIMESTAMP(3),
ADD COLUMN     "courierError" TEXT,
ADD COLUMN     "courierFolderItemId" TEXT,
ADD COLUMN     "courierFolderPath" TEXT;

-- CreateTable
CREATE TABLE "CourierImportFailure" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "itemId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "lastModified" TIMESTAMP(3),
    "code" TEXT NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierImportFailure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourierImportFailure_tenantId_idx" ON "CourierImportFailure"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CourierImportFailure_tenantId_itemId_key" ON "CourierImportFailure"("tenantId", "itemId");

-- AddForeignKey
ALTER TABLE "CourierImportFailure" ADD CONSTRAINT "CourierImportFailure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

