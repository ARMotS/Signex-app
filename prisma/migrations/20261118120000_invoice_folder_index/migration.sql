-- The invoice folder index: what the Invoices tab reads instead of listing the
-- whole invoice folder (and its signed/ subfolder) over Microsoft Graph on
-- every load. Kept current by Graph delta and by Signex's own writes. Purely
-- additive: a branch whose index is not complete keeps listing the folder.

-- AlterTable
ALTER TABLE "CloudAccount" ADD COLUMN     "invoiceCheckedAt" TIMESTAMP(3),
ADD COLUMN     "invoiceDeltaLink" TEXT,
ADD COLUMN     "invoiceIndexError" TEXT,
ADD COLUMN     "invoiceIndexFolderId" TEXT,
ADD COLUMN     "invoiceIndexReadyAt" TIMESTAMP(3),
ADD COLUMN     "invoiceIndexSyncedAt" TIMESTAMP(3),
ADD COLUMN     "invoiceSignedFolderId" TEXT;

-- CreateTable
CREATE TABLE "InvoiceFolderFile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "itemId" TEXT NOT NULL,
    "parentId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceFolderFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceFolderFile_tenantId_parentId_idx" ON "InvoiceFolderFile"("tenantId", "parentId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceFolderFile_tenantId_itemId_key" ON "InvoiceFolderFile"("tenantId", "itemId");

-- AddForeignKey
ALTER TABLE "InvoiceFolderFile" ADD CONSTRAINT "InvoiceFolderFile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
