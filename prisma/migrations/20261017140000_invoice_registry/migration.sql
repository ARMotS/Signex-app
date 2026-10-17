-- A durable record per invoice NUMBER: the anchor of the invoice → collection
-- → credit note chain, and where the invoice's own date and customer live.
--
-- Additive only: a new table and a nullable column. Nothing existing reads
-- either, so the previous deploy keeps working against this schema. Rows are
-- filled as the Invoices page lists the folder and as trips deploy; headers
-- (date / customer) by `npm run db:backfill-invoice-headers`.

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "invoiceNo" TEXT NOT NULL,
    "invoiceNoNormalized" TEXT NOT NULL,
    "pdfFilename" TEXT,
    "isStub" BOOLEAN NOT NULL DEFAULT false,
    "customerName" TEXT,
    "deliverToName" TEXT,
    "billToName" TEXT,
    "invoiceDate" DATE,
    "headerSource" TEXT,
    "headerAttempts" INTEGER NOT NULL DEFAULT 0,
    "headerError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "invoiceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_invoiceNoNormalized_key" ON "Invoice"("tenantId", "invoiceNoNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_id_key" ON "Invoice"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_invoiceDate_idx" ON "Invoice"("tenantId", "invoiceDate");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_customerName_idx" ON "Invoice"("tenantId", "customerName");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_headerSource_idx" ON "Invoice"("tenantId", "headerSource");

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;
