-- Credit-note intake: the branch's credits folder on the OneDrive connection,
-- and the credit notes read from it, their lines, and the collections each
-- one pays for.
--
-- Additive only: a new enum, four nullable columns and three new tables.
-- Nothing the previous deploy runs reads any of them.

-- CreateEnum
CREATE TYPE "CreditNoteStatus" AS ENUM ('RECEIVED', 'NEEDS_REVIEW', 'SIGNED', 'REJECTED');

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "creditsCheckedAt" TIMESTAMP(3),
ADD COLUMN     "creditsError" TEXT,
ADD COLUMN     "creditsFolderItemId" TEXT,
ADD COLUMN     "creditsFolderPath" TEXT;

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "creditNo" TEXT,
    "creditNoNormalized" TEXT,
    "creditNoClaim" TEXT,
    "invoiceNo" TEXT,
    "invoiceNoNormalized" TEXT,
    "invoiceId" TEXT,
    "creditDate" DATE,
    "accountNo" TEXT,
    "deliverToName" TEXT,
    "billToName" TEXT,
    "subtotal" DECIMAL(12,2),
    "vatAmount" DECIMAL(12,2),
    "total" DECIMAL(12,2),
    "status" "CreditNoteStatus" NOT NULL DEFAULT 'RECEIVED',
    "issues" JSONB,
    "readSource" TEXT,
    "readAt" TIMESTAMP(3),
    "readError" TEXT,
    "rejectReason" TEXT,
    "sourceItemId" TEXT NOT NULL,
    "sourceFilename" TEXT NOT NULL,
    "sourceFolder" TEXT NOT NULL,
    "sourceModifiedAt" TIMESTAMP(3),
    "fileError" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "creditNoteId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "productCode" TEXT,
    "shortName" TEXT,
    "bin" TEXT,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "unitPrice" DECIMAL(12,2),
    "discountPct" DECIMAL(6,2),
    "nett" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNoteLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNoteCollection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "creditNoteId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "linkedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNoteCollection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditNote_tenantId_status_idx" ON "CreditNote"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CreditNote_tenantId_invoiceNoNormalized_idx" ON "CreditNote"("tenantId", "invoiceNoNormalized");

-- CreateIndex
CREATE INDEX "CreditNote_tenantId_creditDate_idx" ON "CreditNote"("tenantId", "creditDate");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_tenantId_sourceItemId_key" ON "CreditNote"("tenantId", "sourceItemId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_tenantId_creditNoClaim_key" ON "CreditNote"("tenantId", "creditNoClaim");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_tenantId_id_key" ON "CreditNote"("tenantId", "id");

-- CreateIndex
CREATE INDEX "CreditNoteLine_tenantId_creditNoteId_idx" ON "CreditNoteLine"("tenantId", "creditNoteId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteLine_tenantId_creditNoteId_lineNo_key" ON "CreditNoteLine"("tenantId", "creditNoteId", "lineNo");

-- CreateIndex
CREATE INDEX "CreditNoteCollection_tenantId_collectionId_idx" ON "CreditNoteCollection"("tenantId", "collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNoteCollection_tenantId_creditNoteId_collectionId_key" ON "CreditNoteCollection"("tenantId", "creditNoteId", "collectionId");

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CreditNoteLine" ADD CONSTRAINT "CreditNoteLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteLine" ADD CONSTRAINT "CreditNoteLine_tenantId_creditNoteId_fkey" FOREIGN KEY ("tenantId", "creditNoteId") REFERENCES "CreditNote"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CreditNoteCollection" ADD CONSTRAINT "CreditNoteCollection_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteCollection" ADD CONSTRAINT "CreditNoteCollection_tenantId_creditNoteId_fkey" FOREIGN KEY ("tenantId", "creditNoteId") REFERENCES "CreditNote"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CreditNoteCollection" ADD CONSTRAINT "CreditNoteCollection_tenantId_collectionId_fkey" FOREIGN KEY ("tenantId", "collectionId") REFERENCES "Collection"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

