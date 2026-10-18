-- A record of each collection the office took off a live run before the
-- driver got to it (the customer rang to say not to collect).
--
-- Additive only: a new table. Nothing the previous deploy runs reads it.

-- CreateTable
CREATE TABLE "RemovedCollection" (
    "id" TEXT NOT NULL,
    "tripSheetId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "driverName" TEXT NOT NULL,
    "stopNumber" INTEGER NOT NULL,
    "collectionNo" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "originalInvoiceNo" TEXT,
    "expectedQty" INTEGER,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "stopRemoved" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT NOT NULL,
    "removedBy" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "RemovedCollection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RemovedCollection_tenantId_tripSheetId_idx" ON "RemovedCollection"("tenantId", "tripSheetId");

-- CreateIndex
CREATE INDEX "RemovedCollection_tenantId_removedAt_idx" ON "RemovedCollection"("tenantId", "removedAt");

-- AddForeignKey
ALTER TABLE "RemovedCollection" ADD CONSTRAINT "RemovedCollection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

