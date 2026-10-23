-- The courier handover: who dispatched, who collected, the courier driver's
-- signature, when, and where each invoice's stamped copy was filed.
--
-- Additive only: nullable columns on CourierTripSheet and
-- CourierTripSheetInvoice.

-- AlterTable
ALTER TABLE "CourierTripSheet" ADD COLUMN     "collectedAt" TIMESTAMP(3),
ADD COLUMN     "courierDriverName" TEXT,
ADD COLUMN     "dispatchCompany" TEXT,
ADD COLUMN     "dispatcherName" TEXT,
ADD COLUMN     "dispatcherUserId" TEXT,
ADD COLUMN     "driverSignature" TEXT,
ADD COLUMN     "filingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "filingError" TEXT;

-- AlterTable
ALTER TABLE "CourierTripSheetInvoice" ADD COLUMN     "signedAt" TIMESTAMP(3),
ADD COLUMN     "signedFileId" TEXT,
ADD COLUMN     "signedFileName" TEXT,
ADD COLUMN     "signedFilePath" TEXT;

