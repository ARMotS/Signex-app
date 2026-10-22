-- Courier trip sheets: invoices that leave by courier, one sheet per customer,
-- signed for by the courier driver and confirmed by the customer.
--
-- Additive only: a new enum and two new tables. Nothing existing changes.
--
-- Composite foreign keys ([tenantId, id] targets) make a courier sheet that
-- points at another scope's contact or invoice unrepresentable, as for Stop.
-- The signing and confirmation columns arrive with those steps.

-- CreateEnum
CREATE TYPE "CourierStatus" AS ENUM ('NEEDS_ATTENTION', 'AWAITING_COLLECTION', 'COLLECTED', 'DELIVERED');

-- CreateTable
CREATE TABLE "CourierTripSheet" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "courierSheetNo" TEXT NOT NULL,
    "sheetDate" DATE NOT NULL,
    "courierCompany" TEXT,
    "courierService" TEXT,
    "courierContact" TEXT,
    "customerName" TEXT NOT NULL,
    "contactId" TEXT,
    "customerEmail" TEXT,
    "parcels" INTEGER,
    "waybills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "CourierStatus" NOT NULL DEFAULT 'AWAITING_COLLECTION',
    "issues" JSONB,
    "checkedAt" TIMESTAMP(3),
    "sourceFileName" TEXT NOT NULL,
    "sourceFileId" TEXT,
    "sourceFilePath" TEXT,
    "sourceFileBytes" BYTEA,
    "sourceFileError" TEXT,
    "importTemplateId" TEXT,
    "mappingSnapshot" JSONB,
    "importedById" TEXT NOT NULL,
    "importedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourierTripSheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourierTripSheetInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "courierSheetId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "invoiceNoNormalized" TEXT,
    "invoiceId" TEXT,
    "invoiceFile" TEXT,
    "invoiceDate" DATE,
    "waybillNo" TEXT NOT NULL,
    "parcels" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourierTripSheetInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourierTripSheet_tenantId_status_idx" ON "CourierTripSheet"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CourierTripSheet_tenantId_sheetDate_idx" ON "CourierTripSheet"("tenantId", "sheetDate");

-- CreateIndex
CREATE UNIQUE INDEX "CourierTripSheet_tenantId_courierSheetNo_key" ON "CourierTripSheet"("tenantId", "courierSheetNo");

-- CreateIndex
CREATE UNIQUE INDEX "CourierTripSheet_tenantId_id_key" ON "CourierTripSheet"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CourierTripSheetInvoice_tenantId_invoiceNoNormalized_idx" ON "CourierTripSheetInvoice"("tenantId", "invoiceNoNormalized");

-- CreateIndex
CREATE INDEX "CourierTripSheetInvoice_courierSheetId_idx" ON "CourierTripSheetInvoice"("courierSheetId");

-- CreateIndex
CREATE UNIQUE INDEX "CourierTripSheetInvoice_tenantId_courierSheetId_lineNo_key" ON "CourierTripSheetInvoice"("tenantId", "courierSheetId", "lineNo");

-- AddForeignKey
ALTER TABLE "CourierTripSheet" ADD CONSTRAINT "CourierTripSheet_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierTripSheet" ADD CONSTRAINT "CourierTripSheet_tenantId_contactId_fkey" FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CourierTripSheetInvoice" ADD CONSTRAINT "CourierTripSheetInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourierTripSheetInvoice" ADD CONSTRAINT "CourierTripSheetInvoice_tenantId_courierSheetId_fkey" FOREIGN KEY ("tenantId", "courierSheetId") REFERENCES "CourierTripSheet"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CourierTripSheetInvoice" ADD CONSTRAINT "CourierTripSheetInvoice_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

