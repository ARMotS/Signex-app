-- Vehicles: a branch's fleet, and an optional link from a trip sheet to the
-- vehicle its REGNO names.
--
-- Purely additive. TripSheet.regNo keeps the sheet's raw REGNO exactly as
-- before; vehicleId is set only when that REGNO's registration key matches one
-- of the scope's vehicles, and never blocks or warns. The composite FK makes a
-- trip pointing at another scope's vehicle unrepresentable (a null vehicleId
-- switches it off, MATCH SIMPLE), and RESTRICT means a vehicle that is on a
-- live trip is deactivated, never deleted. CompletedTripSheet.vehicleId is the
-- archive's frozen copy and has no FK, like driverId.

ALTER TYPE "AuditAction" ADD VALUE 'VEHICLE_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'VEHICLE_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'VEHICLE_DELETE';

-- AlterTable
ALTER TABLE "CompletedTripSheet" ADD COLUMN     "vehicleId" TEXT;

-- AlterTable
ALTER TABLE "TripSheet" ADD COLUMN     "vehicleId" TEXT;

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "registrationKey" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "type" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "licenceDiscExpiry" DATE,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vehicle_tenantId_idx" ON "Vehicle"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_tenantId_registrationKey_key" ON "Vehicle"("tenantId", "registrationKey");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_tenantId_id_key" ON "Vehicle"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CompletedTripSheet_tenantId_vehicleId_idx" ON "CompletedTripSheet"("tenantId", "vehicleId");

-- CreateIndex
CREATE INDEX "TripSheet_vehicleId_idx" ON "TripSheet"("vehicleId");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TripSheet" ADD CONSTRAINT "TripSheet_tenantId_vehicleId_fkey" FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

