-- Reallocating stops from one driver's live run to another's.
--
-- Additive only: one new table, nothing altered or dropped, so the previous
-- deploy's code keeps working against this schema.

-- CreateTable
CREATE TABLE "ReallocatedStop" (
    "id" TEXT NOT NULL,
    "fromTripSheetId" TEXT NOT NULL,
    "toTripSheetId" TEXT NOT NULL,
    "fromDriverId" TEXT NOT NULL,
    "fromDriverName" TEXT NOT NULL,
    "toDriverId" TEXT NOT NULL,
    "toDriverName" TEXT NOT NULL,
    "fromStopNumber" INTEGER NOT NULL,
    "toStopNumber" INTEGER NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "reason" TEXT,
    "reallocatedBy" TEXT NOT NULL,
    "reallocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tenantId" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "ReallocatedStop_pkey" PRIMARY KEY ("id"),
    -- Reallocating to the same driver is refused by the application; a record
    -- claiming it happened would be meaningless.
    CONSTRAINT "ReallocatedStop_distinct_drivers_check" CHECK ("fromDriverId" <> "toDriverId")
);

-- CreateIndex
CREATE INDEX "ReallocatedStop_tenantId_fromTripSheetId_idx" ON "ReallocatedStop"("tenantId", "fromTripSheetId");

-- CreateIndex
CREATE INDEX "ReallocatedStop_tenantId_toTripSheetId_idx" ON "ReallocatedStop"("tenantId", "toTripSheetId");

-- AddForeignKey
ALTER TABLE "ReallocatedStop" ADD CONSTRAINT "ReallocatedStop_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
