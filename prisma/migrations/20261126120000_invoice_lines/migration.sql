-- Invoice product lines (manual trip builder, session 5).
--
-- Purely additive. Every existing invoice reads as "lines not read yet"
-- (linesStatus NULL); nothing reads them in the background, so this deploy
-- makes no PDF downloads and no Claude calls by itself.
--
-- Quantities only (user decision, 2026-11-25): no price column. What has been
-- collected against a line is derived from CollectionLine, never stored.
-- Lines cascade from their invoice, so the admin-workspace purge (which
-- deletes invoices explicitly) removes them with it.

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "linesAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "linesClaimedAt" TIMESTAMP(3),
ADD COLUMN     "linesError" TEXT,
ADD COLUMN     "linesIssues" JSONB,
ADD COLUMN     "linesPdfFilename" TEXT,
ADD COLUMN     "linesReadAt" TIMESTAMP(3),
ADD COLUMN     "linesSource" TEXT,
ADD COLUMN     "linesStatus" TEXT;

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "invoiceId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "itemCode" TEXT,
    "shortName" TEXT,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(12,3) NOT NULL,
    "uom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceLine_tenantId_invoiceId_idx" ON "InvoiceLine"("tenantId", "invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_tenantId_invoiceId_lineNo_key" ON "InvoiceLine"("tenantId", "invoiceId", "lineNo");

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "Invoice"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- A line is something to deliver: a zero or negative count is a misread.
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_qty_positive" CHECK ("qty" > 0);
