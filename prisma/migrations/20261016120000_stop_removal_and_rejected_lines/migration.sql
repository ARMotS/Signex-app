-- Rejected deliveries: an invoice taken off a live trip sheet, and single
-- lines of an invoice the customer refused while accepting the rest.
--
-- Additive only: two new tables, nothing altered or dropped, so the previous
-- deploy's code keeps working against this schema.

-- CreateTable
CREATE TABLE "RemovedStop" (
    "id" TEXT NOT NULL,
    "tripSheetId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "driverName" TEXT NOT NULL,
    "stopNumber" INTEGER NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "nop" INTEGER NOT NULL DEFAULT 0,
    "invoiceFile" TEXT,
    "statusAtRemoval" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "removedBy" TEXT NOT NULL,
    "keptForCollections" BOOLEAN NOT NULL DEFAULT false,
    "removedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "RemovedStop_pkey" PRIMARY KEY ("id"),
    -- A signed delivery is never removed; the application refuses it, and this
    -- makes a record claiming otherwise unrepresentable.
    CONSTRAINT "RemovedStop_statusAtRemoval_check" CHECK ("statusAtRemoval" IN ('PENDING', 'IN_PROGRESS')),
    CONSTRAINT "RemovedStop_source_check" CHECK ("source" IN ('REJECTED', 'INVOICE_DELETED'))
);

-- CreateTable
CREATE TABLE "RejectedLine" (
    "id" TEXT NOT NULL,
    "stopId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER,
    "reason" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "RejectedLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RejectedLine_quantity_check" CHECK ("quantity" IS NULL OR "quantity" > 0)
);

-- CreateIndex
CREATE INDEX "RemovedStop_tenantId_tripSheetId_idx" ON "RemovedStop"("tenantId", "tripSheetId");

-- CreateIndex
CREATE INDEX "RemovedStop_tenantId_removedAt_idx" ON "RemovedStop"("tenantId", "removedAt");

-- CreateIndex
CREATE INDEX "RejectedLine_tenantId_idx" ON "RejectedLine"("tenantId");

-- CreateIndex
CREATE INDEX "RejectedLine_stopId_idx" ON "RejectedLine"("stopId");

-- AddForeignKey
ALTER TABLE "RemovedStop" ADD CONSTRAINT "RemovedStop_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RejectedLine" ADD CONSTRAINT "RejectedLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RejectedLine" ADD CONSTRAINT "RejectedLine_tenantId_stopId_fkey" FOREIGN KEY ("tenantId", "stopId") REFERENCES "Stop"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
