-- Trip source, manual trip numbers and courier companies (manual trip builder,
-- session 2).
--
-- Purely additive. Every existing trip sheet, live and archived, takes the
-- default EXCEL: until the builder ships, every trip came from a Trip program
-- sheet. Nothing issues a manual number yet.
--
-- TripNumberCounter keeps the last SX- number issued per scope per day, so a
-- number is never issued twice even after its trip is completed (and deleted).
-- CourierCompany is its own table, not a Contact category: customer emails
-- find their recipient by Contact.companyName, and must never find a courier.

-- CreateEnum
CREATE TYPE "TripSource" AS ENUM ('EXCEL', 'MANUAL');

-- AlterEnum


ALTER TYPE "AuditAction" ADD VALUE 'COURIER_COMPANY_CREATE';
ALTER TYPE "AuditAction" ADD VALUE 'COURIER_COMPANY_UPDATE';
ALTER TYPE "AuditAction" ADD VALUE 'COURIER_COMPANY_DELETE';

-- AlterTable
ALTER TABLE "TripSheet" ADD COLUMN     "source" "TripSource" NOT NULL DEFAULT 'EXCEL';

-- AlterTable
ALTER TABLE "CompletedTripSheet" ADD COLUMN     "source" "TripSource" NOT NULL DEFAULT 'EXCEL';

-- CreateTable
CREATE TABLE "TripNumberCounter" (
    "tenantId" TEXT NOT NULL DEFAULT '',
    "day" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TripNumberCounter_pkey" PRIMARY KEY ("tenantId","day")
);

-- CreateTable
CREATE TABLE "CourierCompany" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "accountNumber" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierCompany_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourierCompany_tenantId_idx" ON "CourierCompany"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CourierCompany_tenantId_nameKey_key" ON "CourierCompany"("tenantId", "nameKey");

-- CreateIndex
CREATE UNIQUE INDEX "CourierCompany_tenantId_id_key" ON "CourierCompany"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "TripNumberCounter" ADD CONSTRAINT "TripNumberCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierCompany" ADD CONSTRAINT "CourierCompany_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A counter row is only ever written by issueManualTripNumber; these keep a
-- hand-edited row from producing a malformed number.
ALTER TABLE "TripNumberCounter" ADD CONSTRAINT "TripNumberCounter_day_check" CHECK ("day" ~ '^[0-9]{6}$');
ALTER TABLE "TripNumberCounter" ADD CONSTRAINT "TripNumberCounter_value_check" CHECK ("value" > 0);

-- hasManualTrips (lib/trip-data.ts): whether the branch has ever completed a
-- manual trip, asked on every trip sheet page and dashboard load.
CREATE INDEX "CompletedTripSheet_tenantId_source_idx" ON "CompletedTripSheet"("tenantId", "source");
