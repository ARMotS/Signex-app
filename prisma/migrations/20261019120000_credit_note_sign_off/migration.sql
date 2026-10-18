-- Credit-note sign-off: who signed, their drawn signature (kept only until
-- the signed copy is filed), what they accepted, where the signed copy went,
-- and what each signed note paid for.
--
-- Additive only: nullable columns, one defaulted boolean, one new table.
-- Nothing the previous deploy runs reads any of them.

-- AlterTable
ALTER TABLE "CreditNote" ADD COLUMN     "acknowledgedIssues" JSONB,
ADD COLUMN     "acknowledgement" TEXT,
ADD COLUMN     "filedAt" TIMESTAMP(3),
ADD COLUMN     "filingError" TEXT,
ADD COLUMN     "originalRemoved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "signedIncludesSource" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedBy" TEXT,
ADD COLUMN     "signature" TEXT,
ADD COLUMN     "signedAt" TIMESTAMP(3),
ADD COLUMN     "signedByLogin" TEXT,
ADD COLUMN     "signedByName" TEXT,
ADD COLUMN     "signedByUserId" TEXT,
ADD COLUMN     "signedFileId" TEXT,
ADD COLUMN     "signedFilename" TEXT;

-- AlterTable
ALTER TABLE "CreditNoteCollection" ADD COLUMN     "receiptStampedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CreditNoteAllocation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "creditNoteId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "collectionId" TEXT NOT NULL,
    "collectionLineId" TEXT NOT NULL,
    "collectionNo" TEXT NOT NULL,
    "itemCode" TEXT,
    "qty" DECIMAL(12,3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNoteAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditNoteAllocation_tenantId_creditNoteId_idx" ON "CreditNoteAllocation"("tenantId", "creditNoteId");

-- CreateIndex
CREATE INDEX "CreditNoteAllocation_tenantId_collectionLineId_idx" ON "CreditNoteAllocation"("tenantId", "collectionLineId");

-- CreateIndex
CREATE INDEX "CreditNoteAllocation_tenantId_collectionId_idx" ON "CreditNoteAllocation"("tenantId", "collectionId");

-- AddForeignKey
ALTER TABLE "CreditNoteAllocation" ADD CONSTRAINT "CreditNoteAllocation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNoteAllocation" ADD CONSTRAINT "CreditNoteAllocation_tenantId_creditNoteId_fkey" FOREIGN KEY ("tenantId", "creditNoteId") REFERENCES "CreditNote"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

